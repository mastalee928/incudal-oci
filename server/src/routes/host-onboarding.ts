import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { encryptSensitiveData } from '../lib/security.js'
import { OnboardingError, validateCredentials, validateOnboardingInput, resolveOnboardingInput, onboardingCredentials, onboardingPanelOrigin, type OnboardingRequest, type OnboardingCredentials } from '../lib/host-onboarding.js'
import { gatewayCommand, gatewayConfigured } from '../services/onboarding-ssh.js'
import hostInventoryRoutes from './host-inventory.js'

const nodeSelect = {
  id: true, name: true, publicIp: true, sshPort: true, sshFingerprint: true, managementIp: true,
  machineGroup: true, regionGroup: true, countryCode: true,
  hostId: true, status: true, step: true, errorCode: true, attempt: true, createdAt: true, updatedAt: true,
  completedAt: true, host: { select: { status: true, isInstalled: true, architecture: true, agent: { select: { lastSeenAt: true } } } }
} as const
const batchSelect = {
  id: true, name: true, accountLabel: true, defaults: true, createdAt: true,
  nodes: { select: nodeSelect, orderBy: { createdAt: 'asc' as const } }
} as const
const credentialsSchema = { type: 'object', additionalProperties: false, properties: {
  password: { type: 'string', maxLength: 1024 }, privateKey: { type: 'string', maxLength: 32768 }
} } as const

export default async function hostOnboardingRoutes(fastify: FastifyInstance) {
  await fastify.register(hostInventoryRoutes)
  const auth = [fastify.authenticateAdmin]
  fastify.get('/gateway', { onRequest: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!gatewayConfigured()) return { ready: false, code: 'GATEWAY_NOT_CONFIGURED' }
    try {
      onboardingPanelOrigin()
      const gateway = await gatewayCommand()
      return { ready: true, gateway: { controlIp: gateway.controlIp, network: gateway.network, sshHost: gateway.sshHost } }
    } catch (error) { return { ready: false, code: error instanceof OnboardingError ? error.code : 'GATEWAY_UNREACHABLE' } }
  })

  fastify.get<{ Querystring: { page?: string; search?: string } }>('/', { onRequest: auth }, async (request, reply) => {
    const page = Math.max(1, Math.min(100000, Math.trunc(Number(request.query.page)) || 1))
    const search = request.query.search?.trim().slice(0, 100)
    const where = search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { accountLabel: { contains: search, mode: 'insensitive' as const } }, { nodes: { some: { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { publicIp: { contains: search } }] } } }] } : {}
    const [batches, total] = await Promise.all([
      prisma.hostOnboardingBatch.findMany({ where, select: batchSelect, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 10, take: 10 }),
      prisma.hostOnboardingBatch.count({ where })
    ])
    reply.header('Cache-Control', 'no-store')
    return { batches, total, page, pageSize: 10, gatewaySshHost: process.env.ONBOARDING_SSH_JUMP_HOST || process.env.ONBOARDING_GATEWAY_HOST || null }
  })

  fastify.post<{ Body: OnboardingRequest }>('/', {
    onRequest: auth, bodyLimit: 2 * 1024 * 1024,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['requestId', 'name', 'accountLabel', 'defaults', 'nodes'], properties: {
      requestId: { type: 'string', maxLength: 36 }, name: { type: 'string', maxLength: 80 }, accountLabel: { type: 'string', maxLength: 80 },
      defaults: { type: 'object', additionalProperties: false, required: ['countryCode', 'storageSize', 'cpuAllowanceMax', 'memoryMax', 'portProtocol'], properties: {
        countryCode: { type: 'string', pattern: '^[a-z]{2}$' }, storageSize: { type: 'integer', minimum: 10, maximum: 10000 },
        machineGroup: { type: 'string', maxLength: 60 }, regionGroup: { type: 'string', maxLength: 60 },
        cpuAllowanceMax: { type: 'integer', minimum: 1, maximum: 100000 }, memoryMax: { type: 'integer', minimum: 256, maximum: 1048576 },
        portProtocol: { type: 'string', enum: ['tcp', 'tcp_udp'] }
      } }, credentials: credentialsSchema, nodes: { type: 'array', minItems: 1, maxItems: 50, items: {
        type: 'object', additionalProperties: false, required: ['name'], properties: {
          name: { type: 'string', minLength: 2, maxLength: 64 }, publicIp: { type: 'string', maxLength: 15 }, address: { type: 'string', maxLength: 254 },
          sshPort: { type: 'integer', minimum: 1, maximum: 65535 }, sshFingerprint: { type: 'string', maxLength: 50 },
          machineGroup: { type: 'string', maxLength: 60 }, regionGroup: { type: 'string', maxLength: 60 }, countryCode: { type: 'string', pattern: '^[a-z]{2}$' },
          ...credentialsSchema.properties
        }
      } }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      validateOnboardingInput(request.body)
      const existing = await prisma.hostOnboardingBatch.findUnique({ where: { id: request.body.requestId }, select: { id: true, createdById: true } })
      if (existing) {
        if (existing.createdById !== request.user.id) return reply.code(409).send({ code: 'INVALID_REQUEST_ID' })
        return { id: existing.id }
      }
      onboardingPanelOrigin()
      await gatewayCommand()
      const input = await resolveOnboardingInput(request.body)
      const names = input.nodes.map(row => row.name), addresses = input.nodes.map(row => row.publicIp)
      const duplicates = await prisma.host.findMany({ where: { OR: [{ userId: request.user.id, name: { in: names } }, { natPublicIp: { in: addresses } }, { ipAddress: { in: addresses } }] }, select: { name: true } })
      if (duplicates.length) return reply.code(409).send({ code: 'HOST_ALREADY_REGISTERED', conflicts: duplicates.map(host => host.name) })
      const batch = await prisma.hostOnboardingBatch.create({ data: {
        id: input.requestId, createdById: request.user.id, name: input.name.trim(), accountLabel: input.accountLabel.trim(),
        defaults: input.defaults as unknown as Prisma.InputJsonObject,
        nodes: { create: input.nodes.map(row => ({
          name: row.name, publicIp: row.publicIp, sshPort: row.sshPort || 22, sshFingerprint: row.sshFingerprint || null,
          machineGroup: row.machineGroup?.trim() || null, regionGroup: row.regionGroup?.trim() || null, countryCode: row.countryCode || null,
          credentialsEncrypted: encryptSensitiveData(JSON.stringify(onboardingCredentials(row, input.credentials))),
          credentialsExpireAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        })) }
      }, select: { id: true } })
      await createLog(request.user.id, 'host', 'host.onboarding.create', `Queued batch "${input.name}" (${input.nodes.length} hosts)`, 'success')
      return reply.code(202).send(batch)
    } catch (error) {
      if (error instanceof OnboardingError) return reply.code(400).send({ code: error.code, error: error.code })
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.hostOnboardingBatch.findUnique({ where: { id: request.body.requestId }, select: { id: true, createdById: true } })
        if (existing?.createdById === request.user.id) return { id: existing.id }
        return reply.code(409).send({ code: 'HOST_ALREADY_REGISTERED' })
      }
      request.log.error('Could not create onboarding batch')
      return reply.code(500).send({ code: 'ONBOARDING_CREATE_FAILED' })
    }
  })

  fastify.post<{ Params: { id: string }; Body: OnboardingCredentials }>('/nodes/:id/retry', {
    onRequest: auth, bodyLimit: 40000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { body: credentialsSchema }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const node = await prisma.hostOnboardingNode.findUnique({ where: { id: request.params.id } })
    if (!node) return reply.code(404).send({ code: 'ONBOARDING_NOT_FOUND' })
    if (!['failed', 'cancelled'].includes(node.status)) return reply.code(409).send({ code: 'ONBOARDING_NOT_RETRYABLE' })
    let encrypted = node.credentialsEncrypted
    if (request.body?.password || request.body?.privateKey) {
      try { validateCredentials(request.body) } catch { return reply.code(400).send({ code: 'SSH_CREDENTIALS_INVALID' }) }
      encrypted = encryptSensitiveData(JSON.stringify({ password: request.body.password, privateKey: request.body.privateKey }))
    } else if (!encrypted || node.credentialsExpireAt < new Date()) return reply.code(400).send({ code: 'SSH_CREDENTIALS_REQUIRED' })
    const updated = await prisma.hostOnboardingNode.updateMany({ where: { id: node.id, status: node.status }, data: {
      status: 'queued', errorCode: null, credentialsEncrypted: encrypted,
      credentialsExpireAt: new Date(Date.now() + 24 * 60 * 60 * 1000), startedAt: null, completedAt: null, leaseToken: null, leaseUntil: null
    } })
    if (!updated.count) return reply.code(409).send({ code: 'ONBOARDING_NOT_RETRYABLE' })
    await createLog(request.user.id, 'host', 'host.onboarding.retry', `Retried onboarding host "${node.name}"`, 'success')
    return { success: true }
  })

  fastify.post<{ Params: { id: string } }>('/nodes/:id/cancel', {
    onRequest: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const updated = await prisma.hostOnboardingNode.updateMany({ where: { id: request.params.id, status: { in: ['queued', 'failed'] } }, data: {
      status: 'cancelled', credentialsEncrypted: null, completedAt: new Date()
    } })
    if (!updated.count) return reply.code(409).send({ code: 'ONBOARDING_ALREADY_RUNNING' })
    await createLog(request.user.id, 'host', 'host.onboarding.cancel', `Cancelled onboarding task ${request.params.id}`, 'success')
    return { success: true }
  })
}
