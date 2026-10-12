/**
 * 一机一卖的多台订单接口：购物车结算与「直接付款」共用。
 * 挂在 /api/instances 前缀下。
 */
import type { FastifyInstance } from 'fastify'
import { apiError, ErrorCode, type ErrorCodeType } from '../lib/errors.js'
import { placePoolOrder, PoolOrderError, type PoolOrderInput } from '../services/pool-orders.js'

const STATUS_BY_CODE: Partial<Record<ErrorCodeType, number>> = {
  [ErrorCode.POOL_STOCK_SHORT]: 409,
  [ErrorCode.POOL_PRICE_CHANGED]: 409,
  [ErrorCode.SSH_KEY_NOT_OWNED]: 403
}

export default async function poolOrderRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: PoolOrderInput }>('/pool-order', {
    onRequest: [fastify.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'sshKeyId', 'expectedTotal'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['poolPriceId', 'quantity', 'namePrefix', 'image'],
              properties: {
                poolPriceId: { type: 'integer', minimum: 1 },
                quantity: { type: 'integer', minimum: 1, maximum: 1000 },
                namePrefix: { type: 'string', minLength: 2, maxLength: 60 },
                image: { type: 'string', minLength: 1, maxLength: 200 },
                customInitCommandIds: { type: 'array', maxItems: 50, items: { type: 'integer', minimum: 1 } }
              }
            }
          },
          sshKeyId: { type: 'integer', minimum: 1 },
          expectedTotal: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const result = await placePoolOrder(request.user.id, request.user.username, request.body)
      return reply.code(202).send(result)
    } catch (error) {
      if (error instanceof PoolOrderError) {
        return reply.code(STATUS_BY_CODE[error.code] ?? 400).send({ ...apiError(error.code, error.message), ...error.details })
      }
      throw error
    }
  })
}
