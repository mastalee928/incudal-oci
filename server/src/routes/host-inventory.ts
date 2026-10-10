import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { validHostGroup, isOnboardingPublicIPv4 } from '../lib/host-onboarding.js'
import { portProtocolSelect, portProtocolView } from '../services/host-port-protocol.js'

export default async function hostInventoryRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { page?: string; search?: string; machineGroup?: string; regionGroup?: string } }>('/inventory', {
    onRequest: [fastify.authenticateAdmin],
    schema: { querystring: { type: 'object', properties: {
      page: { type: 'integer', minimum: 1, maximum: 100000 }, search: { type: 'string', maxLength: 100 },
      machineGroup: { type: 'string', maxLength: 60 }, regionGroup: { type: 'string', maxLength: 60 }
    } } }
  }, async (request, reply) => {
    const page = Number(request.query.page) || 1
    const search = request.query.search?.trim()
    const where: Prisma.HostWhereInput = {
      ...(request.query.machineGroup ? { machineGroup: request.query.machineGroup } : {}),
      ...(request.query.regionGroup ? { regionGroup: request.query.regionGroup } : {}),
      ...(search ? { OR: [
        { name: { contains: search, mode: 'insensitive' } }, { natPublicIp: { contains: search } },
        { url: { contains: search, mode: 'insensitive' } }, { location: { contains: search, mode: 'insensitive' } },
        { onboardingNode: { batch: { accountLabel: { contains: search, mode: 'insensitive' } } } }
      ] } : {})
    }
    const [hosts, total, machineGroups, regionGroups] = await Promise.all([
      prisma.host.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 20, take: 20, select: {
        id: true, name: true, location: true, url: true, countryCode: true, natPublicIp: true, ipAddress: true,
        machineGroup: true, regionGroup: true, architecture: true, status: true, isInstalled: true,
        ...portProtocolSelect, agent: { select: { lastSeenAt: true } }, _count: { select: { instances: { where: { status: { not: 'deleted' } } } } },
        onboardingNode: { select: { publicIp: true, batch: { select: { accountLabel: true } } } }
      } }),
      prisma.host.count({ where }),
      prisma.host.findMany({ where: { machineGroup: { not: null } }, select: { machineGroup: true }, distinct: ['machineGroup'], orderBy: { machineGroup: 'asc' } }),
      prisma.host.findMany({ where: { regionGroup: { not: null } }, select: { regionGroup: true }, distinct: ['regionGroup'], orderBy: { regionGroup: 'asc' } })
    ])
    reply.header('Cache-Control', 'no-store')
    return { hosts: hosts.map(host => {
      let managementAddress = ''
      try { managementAddress = new URL(host.url).hostname } catch { /* Invalid legacy URLs have no usable address. */ }
      return {
        id: host.id, name: host.name, accountLabel: host.onboardingNode?.batch.accountLabel || host.location,
        publicIp: host.natPublicIp || host.onboardingNode?.publicIp || (isOnboardingPublicIPv4(host.ipAddress) ? host.ipAddress : null),
        managementAddress, countryCode: host.countryCode, machineGroup: host.machineGroup, regionGroup: host.regionGroup,
        architecture: host.architecture, status: host.status, isInstalled: host.isInstalled, instanceCount: host._count.instances,
        portProtocol: portProtocolView(host), agentLastSeenAt: host.agent?.lastSeenAt || null
      }
    }), total, page, pageSize: 20, machineGroups: machineGroups.map(row => row.machineGroup!), regionGroups: regionGroups.map(row => row.regionGroup!) }
  })

  fastify.patch<{ Body: { hostIds: number[]; machineGroup?: string | null; regionGroup?: string | null } }>('/inventory/groups', {
    onRequest: [fastify.authenticateAdmin], config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['hostIds'], properties: {
      hostIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      machineGroup: { type: ['string', 'null'], maxLength: 60 },
      regionGroup: { type: ['string', 'null'], maxLength: 60 }
    } } }
  }, async (request, reply) => {
    const data: Prisma.HostUpdateManyMutationInput = {}
    for (const field of ['machineGroup', 'regionGroup'] as const) {
      const value = request.body[field]
      if (value === undefined) continue
      if (value !== null && !validHostGroup(value)) return reply.code(400).send({ code: 'HOST_GROUP_INVALID' })
      data[field] = value?.trim() || null
    }
    if (!Object.keys(data).length) return reply.code(400).send({ code: 'HOST_GROUP_INVALID' })
    const ids = request.body.hostIds
    const updated = await prisma.$transaction(async tx => {
      if (await tx.host.count({ where: { id: { in: ids } } }) !== ids.length) return null
      return tx.host.updateMany({ where: { id: { in: ids } }, data })
    })
    if (!updated) return reply.code(404).send({ code: 'HOST_NOT_FOUND' })
    await createLog(request.user.id, 'host', 'host.groups.update', `Updated groups for host IDs ${ids.join(', ')}`, 'success')
    return { success: true, updated: updated.count }
  })
}
