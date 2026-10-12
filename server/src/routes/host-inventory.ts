import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { OnboardingError, isOnboardingPublicIPv4, RESOURCE_PRESETS, type ResourcePreset } from '../lib/host-onboarding.js'
import { presetQuota } from '../lib/onboarding-resources.js'
import { portProtocolSelect, portProtocolView } from '../services/host-port-protocol.js'
import { lockHostGroups, resolveHostGroups, type HostGroupInput } from '../services/host-groups.js'
import { HOST_OCCUPIED_INSTANCE_WHERE } from '../lib/host-resource-usage.js'

const occupied = HOST_OCCUPIED_INSTANCE_WHERE
const count = () => ({ total: 0, available: 0, assigned: 0, unavailable: 0 })
type Counts = ReturnType<typeof count>
type StockState = 'available' | 'assigned' | 'unavailable'
function stockState(host: { status: string; isInstalled: boolean; _count: { instances: number }; onboardingNode: { status: string } | null; agent: { enabled: boolean; lastSeenAt: Date | null } | null }): StockState {
  if (host._count.instances > 0) return 'assigned'
  const onboarded = !host.onboardingNode || (host.onboardingNode.status === 'succeeded' &&
    host.agent?.enabled && host.agent.lastSeenAt && Date.now() - host.agent.lastSeenAt.getTime() < 90000)
  return host.status === 'online' && host.isInstalled && onboarded ? 'available' : 'unavailable'
}

export default async function hostInventoryRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { page?: number; search?: string; machineGroup?: string; regionGroup?: string; machineGroupId?: number; regionGroupId?: number; stock?: StockState } }>('/inventory', {
    onRequest: [fastify.authenticateAdmin],
    schema: { querystring: { type: 'object', properties: {
      page: { type: 'integer', minimum: 1, maximum: 100000 }, search: { type: 'string', maxLength: 100 },
      machineGroup: { type: 'string', maxLength: 60 }, regionGroup: { type: 'string', maxLength: 60 },
      machineGroupId: { type: 'integer', minimum: 0 }, regionGroupId: { type: 'integer', minimum: 0 },
      stock: { enum: ['available', 'assigned', 'unavailable'] }
    } } }
  }, async (request, reply) => {
    const page = Number(request.query.page) || 1
    const search = request.query.search?.trim()
    const where: Prisma.HostWhereInput = {
      ...(request.query.machineGroup ? { machineGroup: request.query.machineGroup } : {}),
      ...(request.query.regionGroup ? { regionGroup: request.query.regionGroup } : {}),
      ...(request.query.machineGroupId !== undefined ? { machineGroupId: request.query.machineGroupId || null } : {}),
      ...(request.query.regionGroupId !== undefined ? { regionGroupId: request.query.regionGroupId || null } : {}),
      ...(search ? { OR: [
        { name: { contains: search, mode: 'insensitive' } }, { natPublicIp: { contains: search } },
        { location: { contains: search, mode: 'insensitive' } },
        { instances: { some: { ...occupied, user: { username: { contains: search, mode: 'insensitive' } } } } },
        { onboardingNode: { batch: { accountLabel: { contains: search, mode: 'insensitive' } } } }
      ] } : {})
    }
    // A compact snapshot makes counts independent of the current page and search.
    const [inventory, groups, moves] = await Promise.all([
      prisma.host.findMany({ select: { id: true, machineGroupId: true, regionGroupId: true, status: true, isInstalled: true,
        _count: { select: { instances: { where: occupied } } }, onboardingNode: { select: { status: true } }, agent: { select: { enabled: true, lastSeenAt: true } } } }),
      prisma.hostMachineGroup.findMany({ orderBy: { id: 'asc' }, include: { regions: { orderBy: { id: 'asc' } } } }),
      prisma.instanceTask.findMany({ where: { taskType: 'change_host', status: { in: ['PENDING', 'PROCESSING'] }, targetHostId: { not: null } }, select: { targetHostId: true } })
    ])
    const summary = count(), ungrouped = count()
    const machineCounts = new Map<number, Counts>(), regionCounts = new Map<number, Counts>()
    const stateById = new Map<number, StockState>()
    const increment = (target: Counts, state: StockState) => { target.total++; target[state]++ }
    const reserved = new Set(moves.map(task => task.targetHostId))
    for (const host of inventory) {
      const state = host._count.instances === 0 && reserved.has(host.id) ? 'unavailable' : stockState(host)
      stateById.set(host.id, state)
      increment(summary, state)
      if (host.machineGroupId === null) increment(ungrouped, state)
      else {
        if (!machineCounts.has(host.machineGroupId)) machineCounts.set(host.machineGroupId, count())
        increment(machineCounts.get(host.machineGroupId)!, state)
      }
      if (host.regionGroupId !== null) {
        if (!regionCounts.has(host.regionGroupId)) regionCounts.set(host.regionGroupId, count())
        increment(regionCounts.get(host.regionGroupId)!, state)
      }
    }
    if (request.query.stock) where.id = { in: inventory.filter(host => stateById.get(host.id) === request.query.stock).map(host => host.id) }
    const [hosts, total] = await Promise.all([
      prisma.host.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * 20, take: 20, select: {
        id: true, name: true, location: true, url: true, countryCode: true, natPublicIp: true, ipAddress: true,
        machineGroup: true, regionGroup: true, machineGroupId: true, regionGroupId: true,
        machineGroupEntry: { select: { name: true } }, regionGroupEntry: { select: { name: true } },
        architecture: true, status: true, isInstalled: true, resourcePreset: true, customerDiskGiB: true,
        cpuAllowanceMax: true, memoryMax: true, storageSize: true, resourceSnapshot: true, singleTenant: true,
        ...portProtocolSelect, agent: { select: { lastSeenAt: true } },
        instances: { where: occupied, select: { id: true, name: true, status: true, cpu: true, memory: true, disk: true, user: { select: { id: true, username: true } } }, orderBy: { id: 'asc' } },
        onboardingNode: { select: { publicIp: true, batch: { select: { accountLabel: true } } } }
      } }),
      prisma.host.count({ where })
    ])
    reply.header('Cache-Control', 'no-store')
    return { hosts: hosts.map(host => {
      let managementAddress = ''
      try { managementAddress = new URL(host.url).hostname } catch { /* Legacy URLs may be invalid. */ }
      return {
        id: host.id, name: host.name, accountLabel: host.onboardingNode?.batch.accountLabel || host.location,
        publicIp: host.natPublicIp || host.onboardingNode?.publicIp || (isOnboardingPublicIPv4(host.ipAddress) ? host.ipAddress : null),
        managementAddress, countryCode: host.countryCode,
        machineGroup: host.machineGroupEntry?.name || host.machineGroup, regionGroup: host.regionGroupEntry?.name || host.regionGroup,
        machineGroupId: host.machineGroupId, regionGroupId: host.regionGroupId,
        architecture: host.architecture, status: host.status, isInstalled: host.isInstalled,
        instanceCount: host.instances.length, instances: host.instances, stock: stateById.get(host.id) || 'unavailable',
        resourcePreset: host.resourcePreset, customerDiskGiB: host.customerDiskGiB, cpuAllowanceMax: host.cpuAllowanceMax,
        memoryMax: host.memoryMax, storageSize: host.storageSize, resourceSnapshot: host.resourceSnapshot, singleTenant: host.singleTenant,
        portProtocol: portProtocolView(host), agentLastSeenAt: host.agent?.lastSeenAt || null
      }
    }), total, page, pageSize: 20, summary, ungrouped,
    groups: groups.map(group => ({ ...group, counts: machineCounts.get(group.id) || count(),
      regions: group.regions.map(region => ({ ...region, counts: regionCounts.get(region.id) || count() })) })),
    machineGroups: groups.map(group => group.name), regionGroups: [...new Set(groups.flatMap(group => group.regions.map(region => region.name)))] }
  })

  fastify.patch<{ Body: HostGroupInput & { hostIds: number[] } }>('/inventory/groups', {
    onRequest: [fastify.authenticateAdmin], config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['hostIds'], properties: {
      hostIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      machineGroup: { type: ['string', 'null'], maxLength: 60 }, regionGroup: { type: ['string', 'null'], maxLength: 60 },
      machineGroupId: { type: ['integer', 'null'], minimum: 1 }, regionGroupId: { type: ['integer', 'null'], minimum: 1 }
    } } }
  }, async (request, reply) => {
    if (Object.keys(request.body).length < 2) return reply.code(400).send({ code: 'HOST_GROUP_INVALID' })
    const ids = request.body.hostIds
    try {
      const updated = await prisma.$transaction(async tx => {
        await lockHostGroups(tx)
        const hosts = await tx.host.findMany({ where: { id: { in: ids } } })
        if (hosts.length !== ids.length) return null
        for (const host of hosts) {
          const data = await resolveHostGroups(tx, request.body, host)
          await tx.host.update({ where: { id: host.id }, data })
          await tx.hostOnboardingNode.updateMany({ where: { hostId: host.id }, data })
        }
        return hosts.length
      })
      if (updated === null) return reply.code(404).send({ code: 'HOST_NOT_FOUND' })
      await createLog(request.user.id, 'host', 'host.groups.update', 'Updated groups for host IDs ' + ids.join(', '), 'success')
      return { success: true, updated }
    } catch (error) {
      if (error instanceof OnboardingError) return reply.code(400).send({ code: error.code })
      throw error
    }
  })

  /**
   * 给已接入的机器补设规格：机型/核心预设 + 客户磁盘档。
   * CPU 与内存配额按预设自动算，与接入时的口径完全一致；这是机器进入池子（可定价、可售）的前提。
   * 接入前就能选，接入后一直没地方改——这个接口补上这个缺口。
   */
  fastify.patch<{ Body: { hostIds: number[]; resourcePreset: ResourcePreset; customerDiskGiB: number } }>('/inventory/spec', {
    onRequest: [fastify.authenticateAdmin], config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['hostIds', 'resourcePreset', 'customerDiskGiB'], properties: {
      hostIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      resourcePreset: { type: 'string', enum: [...RESOURCE_PRESETS] },
      customerDiskGiB: { type: 'integer', minimum: 10, maximum: 10000 }
    } } }
  }, async (request, reply) => {
    const { hostIds, resourcePreset, customerDiskGiB } = request.body
    const quota = presetQuota(resourcePreset)
    const expectedArchitecture = resourcePreset === 'E2' ? 'x86_64' : 'aarch64'
    try {
      const updated = await prisma.$transaction(async tx => {
        const hosts = await tx.host.findMany({ where: { id: { in: hostIds } }, select: {
          id: true, architecture: true, instances: { where: occupied, select: { cpu: true, memory: true, disk: true } }
        } })
        if (hosts.length !== hostIds.length) return null
        for (const host of hosts) {
          if (host.architecture !== expectedArchitecture) throw new OnboardingError('RESOURCE_ARCHITECTURE_MISMATCH')
          // 已有实例不能超出新配额：否则单租户触发器会在下一次改动实例时拦住，留下半套状态
          if (host.instances.some(i => i.cpu > quota.cpuAllowanceMax || i.memory > quota.memoryMax || i.disk > customerDiskGiB * 1024)) {
            throw new OnboardingError('HOST_SPEC_INSTANCE_EXCEEDS')
          }
          await tx.host.update({ where: { id: host.id }, data: {
            resourcePreset, customerDiskGiB, cpuAllowanceMax: quota.cpuAllowanceMax, memoryMax: quota.memoryMax,
            // 一机一卖的库存单位：最多一个客户实例的机器才标成单租户
            ...(host.instances.length <= 1 ? { singleTenant: true } : {})
          } })
          await tx.hostOnboardingNode.updateMany({ where: { hostId: host.id }, data: { resourcePreset, customerDiskGiB } })
        }
        return hosts.length
      })
      if (updated === null) return reply.code(404).send({ code: 'HOST_NOT_FOUND' })
      await createLog(request.user.id, 'host', 'host.spec.update',
        `Set spec ${resourcePreset} / ${customerDiskGiB} GiB for host IDs ${hostIds.join(', ')}`, 'success')
      return { success: true, updated }
    } catch (error) {
      if (error instanceof OnboardingError) return reply.code(400).send({ code: error.code })
      throw error
    }
  })
}
