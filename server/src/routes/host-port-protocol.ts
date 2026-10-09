import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { PORT_PROTOCOL_CAPABILITY, portProtocolSelect, portProtocolView, type PortProtocol } from '../services/host-port-protocol.js'

export default async function hostPortProtocolRoutes(fastify: FastifyInstance) {
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } }
  fastify.get<{ Params: { id: number } }>('/:id/port-protocol', {
    onRequest: [fastify.authenticate], schema: { params }
  }, async (request, reply) => {
    const host = await prisma.host.findUnique({ where: { id: request.params.id }, select: {
      userId: true, ...portProtocolSelect, agent: { select: { enabled: true, capabilities: true, lastSeenAt: true } }
    } })
    if (!host) return reply.code(404).send(apiError(ErrorCode.HOST_NOT_FOUND))
    if (request.user.role !== 'admin' && host.userId !== request.user.id) return reply.code(403).send(apiError(ErrorCode.FORBIDDEN))
    return {
      ...portProtocolView(host),
      error: host.portProtocolError,
      supported: host.agent?.enabled === true && Array.isArray(host.agent.capabilities) && host.agent.capabilities.includes(PORT_PROTOCOL_CAPABILITY),
      lastSeenAt: host.agent?.lastSeenAt || null
    }
  })

  fastify.patch<{ Params: { id: number }; Body: { protocol: PortProtocol } }>('/:id/port-protocol', {
    onRequest: [fastify.authenticate],
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { params, body: { type: 'object', additionalProperties: false, required: ['protocol'], properties: { protocol: { type: 'string', enum: ['tcp', 'tcp_udp'] } } } }
  }, async (request, reply) => {
    const host = await prisma.host.findUnique({ where: { id: request.params.id }, include: { agent: { select: { enabled: true, capabilities: true } } } })
    if (!host) return reply.code(404).send(apiError(ErrorCode.HOST_NOT_FOUND))
    if (request.user.role !== 'admin' && host.userId !== request.user.id) return reply.code(403).send(apiError(ErrorCode.FORBIDDEN))
    if (!host.agent?.enabled || !Array.isArray(host.agent.capabilities) || !host.agent.capabilities.includes(PORT_PROTOCOL_CAPABILITY)) {
      return reply.code(409).send({ code: 'HOST_AGENT_UPGRADE_REQUIRED', error: 'Update the host Agent before changing the public port protocol.' })
    }
    const updated = await prisma.host.update({ where: { id: host.id }, data: {
      portProtocol: request.body.protocol, portProtocolRevision: { increment: 1 }, portProtocolError: null
    }, select: portProtocolSelect })
    await createLog(request.user.id, 'host', 'host.port_protocol.update', `Updated public ingress protocol on host "${host.name}" to ${request.body.protocol}`, 'success')
    return portProtocolView(updated)
  })
}
