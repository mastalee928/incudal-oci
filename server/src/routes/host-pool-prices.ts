import type { FastifyInstance, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { OnboardingError, RESOURCE_PRESETS } from '../lib/host-onboarding.js'
import { deletePoolPrice, listPoolPrices, poolInventory, upsertPoolPrice, upsertPoolPrices, type PoolPriceInput } from '../services/host-pool-prices.js'

function poolError(error: unknown, reply: FastifyReply) {
  if (error instanceof OnboardingError) return reply.code(400).send({ code: error.code })
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return reply.code(409).send({ code: 'POOL_PRICE_EXISTS' })
    if (error.code === 'P2025') return reply.code(404).send({ code: 'POOL_PRICE_NOT_FOUND' })
  }
  throw error
}

const priceProperties = {
  machineGroupId: { type: 'integer', minimum: 1 },
  resourcePreset: { type: 'string', enum: [...RESOURCE_PRESETS] },
  regionGroupId: { type: 'integer', minimum: 1 },
  diskGiB: { type: 'integer', minimum: 10, maximum: 10000 },
  name: { type: ['string', 'null'], maxLength: 60 },
  monthlyPrice: { type: 'integer', minimum: 0, maximum: 9999999999 }, // 分
  setupFee: { type: 'integer', minimum: 0, maximum: 9999999999 }, // 分
  active: { type: 'boolean' },
  sortOrder: { type: 'integer', minimum: 0, maximum: 100000 }
}

/**
 * 池子定价表：一机一卖的商品与价格。
 * 池子 = 机型分组 + 核心数 + 地区 + 磁盘档；一行 = 一个可售商品，没有行 = 不卖。
 */
export default async function hostPoolPriceRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticateAdmin]
  const config = { rateLimit: { max: 60, timeWindow: '1 minute' } }

  fastify.get<{ Querystring: { machineGroupId?: number; resourcePreset?: string } }>('/prices', {
    onRequest: auth,
    schema: { querystring: { type: 'object', properties: {
      machineGroupId: { type: 'integer', minimum: 1 },
      resourcePreset: { type: 'string', enum: [...RESOURCE_PRESETS] }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { prices: await listPoolPrices(request.query.machineGroupId, request.query.resourcePreset) }
  })

  fastify.put<{ Body: PoolPriceInput }>('/prices', {
    onRequest: auth, config,
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['machineGroupId', 'resourcePreset', 'regionGroupId', 'diskGiB', 'monthlyPrice', 'setupFee'],
      properties: priceProperties } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const result = await upsertPoolPrice(request.body, request.user.id)
      await createLog(request.user.id, 'host', 'host.pool_price.save',
        `Set pool price #${result.price.id} (${request.body.resourcePreset} / ${request.body.diskGiB} GiB)`, 'success')
      return { price: result.price }
    } catch (error) { return poolError(error, reply) }
  })

  // 批量保存：定价表一屏几十格一次提交，避免逐格发请求
  fastify.post<{ Body: { items: PoolPriceInput[] } }>('/prices/batch', {
    onRequest: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['items'], properties: {
      items: { type: 'array', minItems: 1, maxItems: 500, items: {
        type: 'object', additionalProperties: false,
        required: ['machineGroupId', 'resourcePreset', 'regionGroupId', 'diskGiB', 'monthlyPrice', 'setupFee'],
        properties: priceProperties
      } }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const result = await upsertPoolPrices(request.body.items, request.user.id)
      await createLog(request.user.id, 'host', 'host.pool_price.batch', `Saved ${result.saved} pool prices`, 'success')
      return result
    } catch (error) { return poolError(error, reply) }
  })

  fastify.delete<{ Params: { id: number } }>('/prices/:id', {
    onRequest: auth, config,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await deletePoolPrice(request.params.id)
      await createLog(request.user.id, 'host', 'host.pool_price.delete', `Removed pool price #${request.params.id}`, 'success')
      return { success: true }
    } catch (error) { return poolError(error, reply) }
  })

  // 每个池子的「总台数 / 空闲台数」，供定价表与创建页做库存预览。
  // 同时列出「没设规格」的单租户机器：它们不属于任何池子、定不了价，定价页要把它们亮出来并就地补规格。
  fastify.get('/inventory', { onRequest: auth }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const [pools, unspecifiedHosts] = await Promise.all([
      poolInventory(),
      prisma.host.findMany({
        where: { singleTenant: true, OR: [{ resourcePreset: null }, { customerDiskGiB: null }, { cpuAllowanceMax: { lte: 0 } }] },
        select: { id: true, name: true, architecture: true, machineGroupId: true, regionGroupId: true,
          machineGroupEntry: { select: { name: true } }, regionGroupEntry: { select: { name: true } } },
        orderBy: { id: 'asc' }
      })
    ])
    return {
      pools,
      unspecified: unspecifiedHosts.map(host => ({
        id: host.id, name: host.name, architecture: host.architecture,
        machineGroupId: host.machineGroupId, regionGroupId: host.regionGroupId,
        machineGroup: host.machineGroupEntry?.name ?? null, regionGroup: host.regionGroupEntry?.name ?? null
      }))
    }
  })
}
