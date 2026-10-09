import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2, { type Server as SshServer, type Client } from 'ssh2'
import Fastify from 'fastify'
import { validateOnboardingInput, validateCredentials, isOnboardingPublicIPv4, OnboardingError, shellQuote, type OnboardingInput } from '../src/lib/host-onboarding.js'
import { connectOnboardingSsh, sshExec, sshFingerprint, validateGatewayResponse } from '../src/services/onboarding-ssh.js'
import { parseHostOnboardingCsv, OnboardingCsvError } from '../../client/src/utils/hostOnboardingCsv.js'
const { Server, utils } = ssh2
const databaseTest = process.env.ONBOARDING_TEST_DATABASE_URL ? test : test.skip
if (process.env.ONBOARDING_TEST_DATABASE_URL) {
  const url = new URL(process.env.ONBOARDING_TEST_DATABASE_URL)
  assert.ok(url.pathname.startsWith('/incudal_test_'), 'Use a separate incudal_test_* database')
  process.env.DATABASE_URL = url.toString()
}

const valid = (): OnboardingInput => ({ requestId: randomUUID(), name: 'Test batch', accountLabel: 'Test account',
  defaults: { countryCode: 'us', storageSize: 30, memoryMax: 768, cpuAllowanceMax: 200, portProtocol: 'tcp' },
  credentials: { password: 'fixture password' }, nodes: [{ name: 'node-01', publicIp: '8.8.8.8' }] })
function expectCode(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => (error instanceof OnboardingError || error instanceof OnboardingCsvError) && error.code === code)
}
test('onboarding rejects private, reserved and malformed destinations', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.1.1.1', '::1', '8.8.8.8;id', 'example.com', null]) assert.equal(isOnboardingPublicIPv4(ip), false)
  assert.equal(isOnboardingPublicIPv4('192.2.10.11'), true)
  assert.equal(isOnboardingPublicIPv4('8.8.8.8'), true)
})
test('onboarding validates credentials, resources and duplicate rows before queueing', () => {
  assert.doesNotThrow(() => validateOnboardingInput(valid()))
  const duplicate = valid(); duplicate.nodes.push({ name: 'node-02', publicIp: duplicate.nodes[0].publicIp })
  expectCode(() => validateOnboardingInput(duplicate), 'DUPLICATE_IMPORT_ROW')
  const oversized = valid(); oversized.nodes = Array.from({ length: 51 }, () => oversized.nodes[0])
  expectCode(() => validateOnboardingInput(oversized), 'BATCH_SIZE_INVALID')
  const invalid = valid(); invalid.defaults.memoryMax = -1
  expectCode(() => validateOnboardingInput(invalid), 'BATCH_DEFAULTS_INVALID')
  expectCode(() => validateCredentials({ password: {} }), 'SSH_CREDENTIALS_INVALID')
  expectCode(() => validateCredentials({}), 'SSH_CREDENTIALS_REQUIRED')
  expectCode(() => validateOnboardingInput(null), 'INVALID_REQUEST_ID')
  const perHost = valid(); delete perHost.credentials; perHost.nodes[0].password = 'row fixture'
  assert.doesNotThrow(() => validateOnboardingInput(perHost))
})
test('CSV handles BOM, CRLF, quoted commas and multiline credentials without losing content', () => {
  const nodes = parseHostOnboardingCsv('\uFEFFname,publicIp,sshPort,password\r\nnode-01,8.8.8.8,2222,"a,b"\r\n')
  assert.equal(nodes[0].sshPort, 2222); assert.equal(nodes[0].password, 'a,b')
  const key = parseHostOnboardingCsv('name,publicIp,privateKey\nnode-01,8.8.8.8,"first\nsecond"')
  assert.equal(key[0].privateKey, 'first\nsecond')
  assert.equal(parseHostOnboardingCsv('name\tpublicIp\nnode-01\t8.8.8.8')[0].sshPort, 22)
})
test('CSV rejects ambiguous columns, broken quotes and duplicates without echoing credentials', () => {
  expectCode(() => parseHostOnboardingCsv('name,name\na,b'), 'CSV_HEADERS')
  expectCode(() => parseHostOnboardingCsv('name,publicIp\nnode-01,"8.8.8.8'), 'CSV_INVALID')
  expectCode(() => parseHostOnboardingCsv('name,publicIp\nnode-01,8.8.8.8\nnode-02,8.8.8.8'), 'DUPLICATE_IMPORT_ROW')
  try { parseHostOnboardingCsv('name,publicIp\nnode-01,8.8.8.8,never-echo-this') } catch (error) { assert.ok(!String(error).includes('never-echo-this')) }
})
test('gateway responses must stay in the expected management network', () => {
  const response = { publicKey: 'A'.repeat(43) + '=', controlIp: '10.253.240.1', network: '10.253.240.0/24', managementIp: '10.253.240.3', managementSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' }
  assert.equal(validateGatewayResponse(response, 'gateway.example:51820', 'gateway.example').managementIp, '10.253.240.3')
  for (const managementIp of ['10.253.241.3', '10.253.240.1', '10.253.240.0', '10.253.240.255', '10...3']) expectCode(() => validateGatewayResponse({ ...response, managementIp }, 'gateway.example:51820', 'gateway.example'), 'GATEWAY_RESPONSE_INVALID')
  expectCode(() => validateGatewayResponse(response, 'gateway.example:65536', 'gateway.example'), 'GATEWAY_RESPONSE_INVALID')
})

let sshServer: SshServer
let sshPort = 0
let fingerprint = ''
let sshFixtureDirectory = ''
const gatewayFixture = { publicKey: 'A'.repeat(43) + '=', controlIp: '10.253.240.1', network: '10.253.240.0/24', managementSshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' }
const connections = new Set<unknown>()
before(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  const parsed = utils.parseKey(pair.privateKey)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Could not create test host key')
  fingerprint = sshFingerprint(parsed.getPublicSSH())
  sshFixtureDirectory = await mkdtemp(join(tmpdir(), 'incudal-onboarding-test-'))
  await writeFile(join(sshFixtureDirectory, 'gateway.key'), pair.privateKey, { mode: 0o600 })
  sshServer = new Server({ hostKeys: [pair.privateKey] }, connection => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', context => context.username === 'root' && ((context.method === 'password' && context.password === 'test-only') || (context.method === 'publickey' && context.key.data.equals(parsed.getPublicSSH()))) ? context.accept() : context.reject())
    connection.on('ready', () => connection.on('session', accept => accept().on('exec', (accept, _reject, request) => {
      const stream = accept()
      if (request.command === 'never-finish') return
      let input = ''
      stream.on('data', data => { input += data.toString() })
      stream.on('end', () => {
        if (request.command === 'status') { stream.write(JSON.stringify(gatewayFixture)); stream.exit(0) }
        else if (request.command === 'fail') { stream.write('INCUDAL_ERROR:HOST_HAS_INSTANCES\n'); stream.exit(1) }
        else { stream.write(input); stream.exit(0) }
        stream.end()
      })
    })))
  })
  sshServer.listen(0, '127.0.0.1')
  await once(sshServer, 'listening')
  sshPort = (sshServer.address() as { port: number }).port
  if (process.env.ONBOARDING_TEST_DATABASE_URL) {
    process.env.ONBOARDING_GATEWAY_HOST = '127.0.0.1'
    process.env.ONBOARDING_GATEWAY_PORT = String(sshPort)
    process.env.ONBOARDING_GATEWAY_FINGERPRINT = fingerprint
    process.env.ONBOARDING_GATEWAY_KEY_PATH = join(sshFixtureDirectory, 'gateway.key')
    process.env.ONBOARDING_WG_ENDPOINT = 'gateway.example:51820'
    process.env.ONBOARDING_SSH_JUMP_HOST = 'gateway.example'
    process.env.FRONTEND_URL = 'https://panel.example.test'
    process.env.PUBLIC_URL = ''
    process.env.ENCRYPTION_KEY = 'disposable-database-test-encryption-key'
  }
})
after(async () => {
  for (const connection of connections) (connection as { end(): void }).end()
  await new Promise<void>(resolve => sshServer.close(() => resolve()))
  await rm(sshFixtureDirectory, { recursive: true, force: true })
  if (process.env.ONBOARDING_TEST_DATABASE_URL) await (await import('../src/db/prisma.js')).prisma.$disconnect()
})
async function connect(): Promise<Client> {
  return connectOnboardingSsh({ host: '127.0.0.1', port: sshPort, password: 'test-only' }, async value => value === fingerprint)
}
test('SSH rejects a changed host key before authentication', async () => {
  await assert.rejects(connectOnboardingSsh({ host: '127.0.0.1', port: sshPort, password: 'test-only' }, async () => false), (error: unknown) => error instanceof OnboardingError && error.code === 'SSH_HOST_KEY_CHANGED')
})
test('SSH sends script data over stdin and returns only stable remote errors', async () => {
  const client = await connect()
  try {
    const input = "value='$(do-not-run)'; literal `text`\n"
    assert.equal(await sshExec(client, 'stdin', input), input)
    await assert.rejects(sshExec(client, 'fail'), (error: unknown) => error instanceof OnboardingError && error.code === 'HOST_HAS_INSTANCES')
    assert.equal(shellQuote("a'b"), "'a'\"'\"'b'")
  } finally { client.end() }
})
test('SSH timeouts close the connection instead of hanging the queue', async () => {
  const client = await connect()
  await assert.rejects(sshExec(client, 'never-finish', '', 100), (error: unknown) => error instanceof OnboardingError && ['SSH_COMMAND_TIMEOUT', 'SSH_DISCONNECTED'].includes(error.code))
})

databaseTest('protocol reports fence stale revisions and expose reconciliation failures', async () => {
  const { prisma } = await import('../src/db/prisma.js')
  const { acceptPortProtocolReport, portProtocolView } = await import('../src/services/host-port-protocol.js')
  const owner = await prisma.user.create({ data: { username: 'protocol-' + randomUUID(), passwordHash: 'test-only' } })
  const host = await prisma.host.create({ data: { userId: owner.id, name: 'protocol-fixture', url: 'https://10.253.240.40:8443', portProtocol: 'tcp', portProtocolRevision: 2 } })
  const state = () => prisma.host.findUniqueOrThrow({ where: { id: host.id } })
  try {
    await acceptPortProtocolReport(host.id, { mode: 'tcp_udp', revision: 1, applied: true })
    await acceptPortProtocolReport(host.id, { mode: 'tcp', revision: -1, applied: true })
    assert.equal(portProtocolView(await state()).status, 'pending')
    await acceptPortProtocolReport(host.id, { mode: 'tcp', revision: 2, applied: true })
    assert.deepEqual(portProtocolView(await state()), { requested: 'tcp', applied: 'tcp', status: 'applied' })
    await acceptPortProtocolReport(host.id, { mode: 'tcp', revision: 2, applied: false, error: 'do-not-echo-remote-output' })
    assert.equal(portProtocolView(await state()).status, 'failed')
    assert.ok(!(await state()).portProtocolError?.includes('do-not-echo'))
  } finally { await prisma.user.delete({ where: { id: owner.id } }) }
})
databaseTest('batch routes require admin access and protocol changes enforce host ownership', async () => {
  const { prisma } = await import('../src/db/prisma.js')
  const { default: onboardingRoutes } = await import('../src/routes/host-onboarding.js')
  const { default: protocolRoutes } = await import('../src/routes/host-port-protocol.js')
  const owner = await prisma.user.create({ data: { username: 'authorization-' + randomUUID(), passwordHash: 'test-only' } })
  const host = await prisma.host.create({ data: { userId: owner.id, name: 'other-owner', url: 'https://10.253.240.41:8443' } })
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { id: owner.id + 1000000, role: 'user' } })
  app.decorate('authenticateAdmin', async (_request: unknown, reply: any) => reply.code(403).send({ code: 'FORBIDDEN' }))
  await app.register(onboardingRoutes, { prefix: '/api/host-onboarding' })
  await app.register(protocolRoutes, { prefix: '/api/hosts' })
  try {
    for (const [method, url, payload] of [
      ['GET', '/api/host-onboarding/', undefined], ['GET', '/api/host-onboarding', undefined], ['GET', '/api/host-onboarding/gateway', undefined],
      ['POST', '/api/host-onboarding/', valid()], ['POST', '/api/host-onboarding/nodes/test/retry', {}], ['POST', '/api/host-onboarding/nodes/test/cancel', undefined],
      ['GET', '/api/host-onboarding/inventory', undefined], ['PATCH', '/api/host-onboarding/inventory/groups', { hostIds: [2], machineGroup: 'ARM' }],
      ['GET', `/api/hosts/${host.id}/port-protocol`, undefined], ['PATCH', `/api/hosts/${host.id}/port-protocol`, { protocol: 'tcp' }]
    ] as const) assert.equal((await app.inject({ method, url, payload })).statusCode, 403)
  } finally { await app.close(); await prisma.user.delete({ where: { id: owner.id } }) }
})

databaseTest('inventory combines machine and region filters, persists bulk edits and excludes secrets', async () => {
  const { prisma } = await import('../src/db/prisma.js')
  const { default: routes } = await import('../src/routes/host-onboarding.js')
  const owner = await prisma.user.create({ data: { username: 'inventory-' + randomUUID(), passwordHash: 'test-only', role: 'admin' } })
  const app = Fastify()
  app.decorate('authenticateAdmin', async (request: any) => { request.user = { id: owner.id, role: 'admin' } })
  await app.register(routes, { prefix: '/api/host-onboarding' })
  try {
    const fixtures = []
    for (const [name, machineGroup, regionGroup, address] of [['e2-frankfurt', 'E2', 'Frankfurt', '8.8.8.8'], ['arm-tokyo', 'ARM', 'Tokyo', '1.1.1.1'], ['arm-frankfurt', 'ARM', 'Frankfurt', '9.9.9.9']]) {
      fixtures.push(await prisma.host.create({ data: { userId: owner.id, name, machineGroup, regionGroup, url: 'https://10.253.240.' + (fixtures.length + 20) + ':8443', natPublicIp: address, keyPath: '/never-expose.key', serverCertificate: 'never-expose-certificate', installToken: randomUUID() } }))
    }
    const filtered = await app.inject({ url: '/api/host-onboarding/inventory?machineGroup=ARM&regionGroup=Tokyo' })
    assert.equal(filtered.statusCode, 200)
    assert.deepEqual(filtered.json().hosts.map((host: any) => host.id), [fixtures[1].id])
    assert.ok(!filtered.body.includes('never-expose') && !filtered.body.includes('installToken') && !filtered.body.includes('credentialsEncrypted'))
    const patch = await app.inject({ method: 'PATCH', url: '/api/host-onboarding/inventory/groups', payload: { hostIds: fixtures.slice(0, 2).map(host => host.id), machineGroup: 'ARM', regionGroup: 'Osaka' } })
    assert.equal(patch.statusCode, 200); assert.equal(patch.json().updated, 2)
    const saved = await app.inject({ url: '/api/host-onboarding/inventory?machineGroup=ARM&regionGroup=Osaka' })
    assert.equal(saved.json().total, 2)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/host-onboarding/inventory/groups', payload: { hostIds: [fixtures[0].id], regionGroup: null } })).statusCode, 200)
    const first = await prisma.host.findUniqueOrThrow({ where: { id: fixtures[0].id } })
    assert.equal(first.machineGroup, 'ARM'); assert.equal(first.regionGroup, null)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/host-onboarding/inventory/groups', payload: { hostIds: [fixtures[0].id], machineGroup: 'bad\ngroup' } })).statusCode, 400)
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/host-onboarding/inventory/groups', payload: { hostIds: [fixtures[0].id, 2147483647], machineGroup: 'should-not-save' } })).statusCode, 404)
    assert.equal((await prisma.host.findUniqueOrThrow({ where: { id: fixtures[0].id } })).machineGroup, 'ARM')
  } finally { await app.close(); await prisma.user.delete({ where: { id: owner.id } }) }
})

databaseTest('batch creation preserves per-machine groups and credentials stay private through retry and cancellation', async () => {
  const { prisma } = await import('../src/db/prisma.js')
  const { default: routes } = await import('../src/routes/host-onboarding.js')
  const owner = await prisma.user.create({ data: { username: 'batch-' + randomUUID(), passwordHash: 'test-only', role: 'admin' } })
  const app = Fastify()
  app.decorate('authenticateAdmin', async (request: any) => { request.user = { id: owner.id, role: 'admin' } })
  await app.register(routes, { prefix: '/api/host-onboarding' })
  const input = valid()
  input.defaults.machineGroup = 'E2'; input.defaults.regionGroup = 'Frankfurt'
  input.nodes[0].machineGroup = 'ARM'; input.nodes[0].regionGroup = 'Tokyo'; input.nodes[0].countryCode = 'jp'
  try {
    const created = await app.inject({ method: 'POST', url: '/api/host-onboarding', payload: input })
    assert.equal(created.statusCode, 202, created.body)
    assert.equal((await app.inject({ method: 'POST', url: '/api/host-onboarding', payload: input })).json().id, input.requestId)
    const node = await prisma.hostOnboardingNode.findFirstOrThrow({ where: { batchId: input.requestId } })
    assert.equal(node.machineGroup, 'ARM'); assert.equal(node.regionGroup, 'Tokyo'); assert.equal(node.countryCode, 'jp')
    assert.ok(node.credentialsEncrypted && !node.credentialsEncrypted.includes('fixture password'))
    const listed = await app.inject({ url: '/api/host-onboarding' })
    assert.ok(!listed.body.includes('credentialsEncrypted') && !listed.body.includes('fixture password') && !listed.body.includes(node.credentialsEncrypted))
    await prisma.hostOnboardingNode.update({ where: { id: node.id }, data: { status: 'failed' } })
    const retried = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/api/host-onboarding/nodes/${node.id}/retry`, payload: {} })))
    assert.deepEqual(retried.map(response => response.statusCode).sort(), [200, 409])
    assert.equal((await app.inject({ method: 'POST', url: `/api/host-onboarding/nodes/${node.id}/cancel` })).statusCode, 200)
    assert.equal((await prisma.hostOnboardingNode.findUniqueOrThrow({ where: { id: node.id } })).credentialsEncrypted, null)
    assert.equal((await app.inject({ method: 'POST', url: `/api/host-onboarding/nodes/${node.id}/retry`, payload: {} })).statusCode, 400)
    assert.equal((await app.inject({ method: 'POST', url: `/api/host-onboarding/nodes/${node.id}/retry`, payload: { password: 'replacement fixture' } })).statusCode, 200)
    await prisma.hostOnboardingNode.update({ where: { id: node.id }, data: { status: 'running' } })
    assert.equal((await app.inject({ method: 'POST', url: `/api/host-onboarding/nodes/${node.id}/cancel` })).statusCode, 409)
  } finally {
    await app.close(); await prisma.hostOnboardingBatch.deleteMany({ where: { id: input.requestId } }); await prisma.user.delete({ where: { id: owner.id } })
  }
})

databaseTest('worker recovers expired leases, leaves live leases alone and clears expired credentials', async () => {
  const { prisma } = await import('../src/db/prisma.js')
  const worker = await import('../src/workers/hostOnboardingWorker.js')
  const owner = await prisma.user.create({ data: { username: 'worker-' + randomUUID(), passwordHash: 'test-only', role: 'admin', status: 'banned' } })
  const batch = await prisma.hostOnboardingBatch.create({ data: { id: randomUUID(), createdById: owner.id, name: 'lease test', accountLabel: 'test', defaults: valid().defaults as any,
    nodes: { create: [
      { name: 'queued', publicIp: '8.8.4.4', credentialsEncrypted: 'expired fixture', credentialsExpireAt: new Date(0) },
      { name: 'interrupted', publicIp: '1.0.0.1', status: 'running', attempt: 3, leaseToken: 'expired-lease', leaseUntil: new Date(0), credentialsExpireAt: new Date(0) },
      { name: 'active', publicIp: '9.9.9.10', status: 'running', attempt: 2, leaseToken: 'live-lease', leaseUntil: new Date(Date.now() + 120000), credentialsExpireAt: new Date(Date.now() + 120000) }
    ] } }, include: { nodes: true } })
  try {
    worker.startHostOnboardingWorker()
    const deadline = Date.now() + 10000
    while (Date.now() < deadline && await prisma.hostOnboardingNode.count({ where: { batchId: batch.id, status: 'failed' } }) < 2) await new Promise(resolve => setTimeout(resolve, 100))
    const rows = await prisma.hostOnboardingNode.findMany({ where: { batchId: batch.id } })
    assert.equal(rows.find(row => row.name === 'queued')?.attempt, 1)
    assert.equal(rows.find(row => row.name === 'queued')?.credentialsEncrypted, null)
    assert.equal(rows.find(row => row.name === 'interrupted')?.attempt, 3)
    assert.equal(rows.find(row => row.name === 'interrupted')?.status, 'failed')
    assert.equal(rows.find(row => row.name === 'active')?.leaseToken, 'live-lease')
    assert.equal(rows.find(row => row.name === 'active')?.status, 'running')
    assert.ok(rows.filter(row => row.status === 'failed').every(row => row.errorCode === 'ADMIN_REQUIRED'))
  } finally { await worker.stopHostOnboardingWorker(); await prisma.hostOnboardingBatch.delete({ where: { id: batch.id } }); await prisma.user.delete({ where: { id: owner.id } }) }
})
