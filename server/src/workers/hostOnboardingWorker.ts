import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { isIPv4 } from 'net'
import type { Client } from 'ssh2'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { decryptSensitiveData } from '../lib/security.js'
import { OnboardingError, shellQuote as q, onboardingPanelOrigin, type OnboardingDefaults, type OnboardingCredentials } from '../lib/host-onboarding.js'
import { connectOnboardingSsh, gatewayCommand, gatewayConfigured, sshExec } from '../services/onboarding-ssh.js'
import { preflightScript, prepareKeyScript, wireguardScript, installerStartScript, installerPollScript } from '../services/onboarding-scripts.js'
import { withHostAddressRegistryLock, prepareHostAddressSnapshotForWrite, persistHostAddressSnapshot } from '../services/host-address-monitor.js'
import { panelCertificatePaths } from '../lib/incus/incus-tls.js'
import { IncusClient } from '../lib/incus/index.js'
import { normalizeArchitecture } from '../lib/architecture.js'
import { PORT_PROTOCOL_CAPABILITY } from '../services/host-port-protocol.js'

let timer: ReturnType<typeof setInterval> | undefined
let ticking = false
let stopped = true
const active = new Set<Promise<void>>()
const connections = new Set<Client>()
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function claim() {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM host_onboarding_nodes
      WHERE status = 'queued' OR (status = 'running' AND lease_until < NOW())
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`
    if (!rows[0]) return null
    const current = await tx.hostOnboardingNode.findUniqueOrThrow({ where: { id: rows[0].id } })
    return tx.hostOnboardingNode.update({ where: { id: current.id }, data: {
      status: 'running', leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000),
      attempt: current.status === 'queued' ? { increment: 1 } : undefined,
      startedAt: current.startedAt || new Date(), errorCode: null
    }, include: { batch: true, host: true } })
  })
}

async function runNode(node: NonNullable<Awaited<ReturnType<typeof claim>>>) {
  let ssh: Client | undefined
  let lostLease = false
  const where = { id: node.id, leaseToken: node.leaseToken, status: 'running' }
  const checkpoint = async (step: string, data: Prisma.HostOnboardingNodeUpdateManyMutationInput = {}) => {
    if (stopped || lostLease) throw new OnboardingError('WORKER_INTERRUPTED')
    const changed = await prisma.hostOnboardingNode.updateMany({ where, data: { ...data, step, leaseUntil: new Date(Date.now() + 60000) } })
    if (!changed.count) throw new OnboardingError('WORKER_INTERRUPTED')
  }
  const heartbeat = setInterval(() => {
    prisma.hostOnboardingNode.updateMany({ where, data: { leaseUntil: new Date(Date.now() + 60000) } }).then(result => {
      if (!result.count) { lostLease = true; clearInterval(heartbeat); ssh?.destroy() }
    }).catch(() => { lostLease = true; clearInterval(heartbeat); ssh?.destroy() })
  }, 15000)
  const connect = async (host: string, credentials: OnboardingCredentials) => {
    if (stopped || lostLease) throw new OnboardingError('WORKER_INTERRUPTED')
    const client = await connectOnboardingSsh({ host, port: node.sshPort, ...credentials }, async fingerprint => {
      const saved = await prisma.hostOnboardingNode.findUniqueOrThrow({ where: { id: node.id }, select: { sshFingerprint: true } })
      if (stopped || lostLease) return false
      if (saved.sshFingerprint) return saved.sshFingerprint === fingerprint
      const pinned = await prisma.hostOnboardingNode.updateMany({ where: { ...where, sshFingerprint: null }, data: { sshFingerprint: fingerprint } })
      return pinned.count === 1
    })
    connections.add(client)
    client.once('close', () => connections.delete(client))
    return client
  }
  try {
    const owner = await prisma.user.findUnique({ where: { id: node.batch.createdById }, select: { role: true, status: true } })
    if (owner?.role !== 'admin' || owner.status !== 'active') throw new OnboardingError('ADMIN_REQUIRED')
    if (!node.credentialsEncrypted || node.credentialsExpireAt < new Date()) throw new OnboardingError('SSH_CREDENTIALS_REQUIRED')
    const credentials = JSON.parse(decryptSensitiveData(node.credentialsEncrypted)) as OnboardingCredentials
    const defaults = node.batch.defaults as unknown as OnboardingDefaults
    const panelOrigin = onboardingPanelOrigin()
    await checkpoint('checking')
    // Resumed tasks can recover over the management tunnel even if public
    // ports have subsequently been assigned to a customer.
    try { ssh = await connect(node.managementIp || node.publicIp, credentials) }
    catch (error) {
      if (!node.managementIp) throw error
      ssh = await connect(node.publicIp, credentials)
    }
    await sshExec(ssh, 'sh -s', preflightScript(node.id))
    await checkpoint('tunnel')
    const prepared = await sshExec(ssh, 'sh -s', prepareKeyScript(node.id), 240000)
    const publicKey = prepared.match(/INCUDAL_PUBLIC_KEY:([A-Za-z0-9+/]{43}=)/)?.[1]
    const bindIp = prepared.match(/INCUDAL_BIND_IP:([0-9.]+)/)?.[1]
    if (!publicKey || !bindIp || !isIPv4(bindIp)) throw new OnboardingError('NODE_NETWORK_INVALID')
    const gateway = await gatewayCommand(`add ${node.id} ${publicKey}`)
    if (!gateway.managementIp) throw new OnboardingError('GATEWAY_RESPONSE_INVALID')
    await checkpoint('tunnel', { managementIp: gateway.managementIp, nodePublicKey: publicKey })
    await sshExec(ssh, 'sh -s', wireguardScript(node.id, gateway), 60000)
    let management: Client | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      try { management = await connect(gateway.managementIp, credentials); break } catch { await pause(2000) }
    }
    if (!management) throw new OnboardingError('MANAGEMENT_UNREACHABLE')
    ssh.end(); ssh = management

    let host = node.host
    if (!host) {
      const url = `https://${gateway.managementIp}:8443`
      host = await withHostAddressRegistryLock(async () => {
        const snapshot = await prepareHostAddressSnapshotForWrite(url)
        return prisma.$transaction(async tx => {
          const duplicate = await tx.host.findFirst({ where: { OR: [{ natPublicIp: node.publicIp }, { ipAddress: node.publicIp }] }, select: { id: true } })
          if (duplicate) throw new OnboardingError('HOST_ALREADY_REGISTERED')
          const created = await tx.host.create({ data: {
            userId: node.batch.createdById, name: node.name, url, location: node.batch.accountLabel,
            countryCode: node.countryCode || defaults.countryCode, tags: ['oci', node.batch.accountLabel],
            machineGroup: node.machineGroup || defaults.machineGroup?.trim() || null,
            regionGroup: node.regionGroup || defaults.regionGroup?.trim() || null,
            natPublicIp: node.publicIp, natBindIp: bindIp, ipAddress: node.publicIp, natPortStart: 1, natPortEnd: 65535,
            ...panelCertificatePaths(), allowPrivateNetwork: true, storageDriver: 'btrfs', storageType: 'loop', storageSize: defaults.storageSize,
            ipv6Mode: 3, enableResourcePool: false, instanceType: 'container', cpuAllowanceMax: defaults.cpuAllowanceMax, memoryMax: defaults.memoryMax,
            portProtocol: defaults.portProtocol, portProtocolAppliedRevision: defaults.portProtocol === 'tcp' ? 0 : 1,
            installToken: randomUUID(), installTokenExpire: new Date(Date.now() + 24 * 60 * 60 * 1000), certDownloadExpire: new Date(Date.now() + 60 * 60 * 1000)
          } })
          await persistHostAddressSnapshot(created.id, snapshot, 'create', tx)
          const linked = await tx.hostOnboardingNode.updateMany({ where, data: { hostId: created.id } })
          if (!linked.count) throw new OnboardingError('WORKER_INTERRUPTED')
          return created
        })
      })
    }
    await checkpoint('installing')
    if (!host.isInstalled) {
      if (!host.installToken || !host.installTokenExpire || host.installTokenExpire < new Date()) {
        // Only an explicit retry may rotate an expired installer session.
        if (node.attempt < 2) throw new OnboardingError('INSTALL_SESSION_EXPIRED')
        host = await prisma.host.update({ where: { id: host.id }, data: { installToken: randomUUID(), installTokenExpire: new Date(Date.now() + 86400000), certDownloadExpire: new Date(Date.now() + 3600000), certDownloadCount: 0 } })
      }
      await sshExec(ssh, 'sh -s', installerStartScript(node.id, node.attempt, `${panelOrigin}/api/hosts/install.sh/${host.installToken}`, defaults), 150000)
      while (true) {
        await checkpoint('installing')
        if (Date.now() - node.startedAt!.getTime() > 45 * 60 * 1000) throw new OnboardingError('INSTALL_TIMEOUT')
        if ((await sshExec(ssh, 'sh -s', installerPollScript(node.id))).trim() === 'done') break
        await pause(5000)
      }
    }
    await checkpoint('network')
    const networkScript = await readFile(fileURLToPath(new URL('../../../scripts/configure-oci-node-network.sh', import.meta.url)), 'utf8')
    const networkPath = '/root/.incudal-onboarding/' + node.id + '/oci-network.sh'
    await sshExec(ssh, `umask 077; cat > ${q(networkPath)}`, networkScript)
    await sshExec(ssh, `bash ${q(networkPath)} --control-ip ${q(gateway.controlIp)} --management-interface incudal-mgmt --ssh-port ${q(node.sshPort)} --api-port 8443 --persist`, '', 180000)
    await checkpoint('verifying')
    host = await prisma.host.findUniqueOrThrow({ where: { id: host.id } })
    if (!host.serverCertificate || !host.serverFingerprint) throw new OnboardingError('TLS_BOOTSTRAP_MISSING')
    const client = new IncusClient({ url: host.url, ...panelCertificatePaths(), serverCertificate: host.serverCertificate, serverFingerprint: host.serverFingerprint, allowPrivateNetwork: true })
    try {
      const info = await client.connect() as { environment?: { kernel_architecture?: string } }
      await client.getResources()
      await prisma.host.update({ where: { id: host.id }, data: {
        status: 'online', isInstalled: true, installToken: null, installTokenExpire: null, certDownloadExpire: null,
        architecture: normalizeArchitecture(info.environment?.kernel_architecture)
      } })
    } finally { await client.close() }
    let agentReady = false
    for (let attempt = 0; attempt < 36; attempt++) {
      await checkpoint('verifying')
      const check = await prisma.host.findUniqueOrThrow({ where: { id: host.id }, include: { agent: true } })
      if (check.agent?.enabled && check.agent.lastSeenAt && Date.now() - check.agent.lastSeenAt.getTime() < 90000 &&
          Array.isArray(check.agent.capabilities) && check.agent.capabilities.includes(PORT_PROTOCOL_CAPABILITY) &&
          check.portProtocolRevision === check.portProtocolAppliedRevision && !check.portProtocolError) { agentReady = true; break }
      await pause(5000)
    }
    if (!agentReady) throw new OnboardingError('AGENT_NOT_READY')
    await checkpoint('done', { status: 'succeeded', credentialsEncrypted: null, completedAt: new Date(), leaseUntil: null, leaseToken: null })
    await createLog(node.batch.createdById, 'host', 'host.onboarding.complete', `Onboarded host "${node.name}" via management tunnel`, 'success')
  } catch (error) {
    const code = error instanceof OnboardingError ? error.code : 'ONBOARDING_STEP_FAILED'
    // During shutdown, leave the durable job resumable. The detached remote
    // installer keeps running; its PID/exit files prevent duplicate installs.
    if (!stopped && !lostLease && code !== 'WORKER_INTERRUPTED') {
      await prisma.hostOnboardingNode.updateMany({ where, data: { status: 'failed', errorCode: code, completedAt: new Date(), leaseToken: null, leaseUntil: null } })
    }
  } finally { clearInterval(heartbeat); ssh?.end() }
}

async function tick() {
  if (ticking || stopped) return
  ticking = true
  try {
    await prisma.hostOnboardingNode.updateMany({ where: { credentialsExpireAt: { lt: new Date() }, credentialsEncrypted: { not: null } }, data: { credentialsEncrypted: null } })
    if (!gatewayConfigured()) return
    while (active.size < 2 && !stopped) {
      const node = await claim()
      if (!node) break
      const work = runNode(node).catch(() => {}).finally(() => active.delete(work))
      active.add(work)
    }
  } finally { ticking = false }
}

export function startHostOnboardingWorker() {
  if (timer) return
  stopped = false
  timer = setInterval(() => { void tick().catch(() => console.error('[Onboarding] Queue poll failed')) }, 3000)
  void tick().catch(() => console.error('[Onboarding] Initial queue poll failed'))
}
export async function stopHostOnboardingWorker() {
  stopped = true
  clearInterval(timer); timer = undefined
  for (const connection of connections) connection.destroy()
  await Promise.allSettled([...active])
}
