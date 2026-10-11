import type { FastifyInstance, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { OnboardingError, validHostGroup } from '../lib/host-onboarding.js'
import { deleteMachineGroup, deleteRegionGroup, lockHostGroups, renameMachineGroup, renameRegionGroup } from '../services/host-groups.js'

function groupError(error: unknown, reply: FastifyReply) {
  if (error instanceof OnboardingError) return reply.code(400).send({ code: error.code })
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return reply.code(409).send({ code: 'HOST_GROUP_EXISTS' })
    if (error.code === 'P2025') return reply.code(404).send({ code: 'HOST_GROUP_NOT_FOUND' })
  }
  throw error
}

export default async function hostGroupRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticateAdmin]
  const config = { rateLimit: { max: 30, timeWindow: '1 minute' } }
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } }
  const name = { type: 'string', minLength: 1, maxLength: 60 }
  const machineBody = { type: 'object', additionalProperties: false, required: ['name'], properties: { name } }

  fastify.get('/groups', { onRequest: auth }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const groups = await prisma.hostMachineGroup.findMany({ orderBy: { id: 'asc' }, include: {
      regions: { orderBy: { id: 'asc' } }
    } })
    return { groups }
  })

  fastify.post<{ Body: { name: string } }>('/groups/machines', {
    onRequest: auth, config, schema: { body: machineBody }
  }, async (request, reply) => {
    if (!validHostGroup(request.body.name)) return reply.code(400).send({ code: 'HOST_GROUP_INVALID' })
    try {
      const group = await prisma.hostMachineGroup.create({ data: { name: request.body.name.trim() } })
      await createLog(request.user.id, 'host', 'host.group.create', `Created machine group #${group.id}`, 'success')
      return reply.code(201).send(group)
    } catch (error) { return groupError(error, reply) }
  })

  fastify.patch<{ Params: { id: number }; Body: { name: string } }>('/groups/machines/:id', {
    onRequest: auth, config, schema: { params, body: machineBody }
  }, async (request, reply) => {
    try {
      const group = await prisma.$transaction(tx => renameMachineGroup(tx, request.params.id, request.body.name))
      await createLog(request.user.id, 'host', 'host.group.rename', `Renamed machine group #${group.id}`, 'success')
      return group
    } catch (error) { return groupError(error, reply) }
  })

  fastify.delete<{ Params: { id: number } }>('/groups/machines/:id', { onRequest: auth, config, schema: { params } }, async (request, reply) => {
    try {
      await prisma.$transaction(tx => deleteMachineGroup(tx, request.params.id))
      await createLog(request.user.id, 'host', 'host.group.delete', `Deleted machine group #${request.params.id}; hosts retained`, 'success')
      return { success: true }
    } catch (error) { return groupError(error, reply) }
  })

  const countryCode = { type: ['string', 'null'], pattern: '^[a-z]{2}$' }
  fastify.post<{ Body: { machineGroupId: number; name: string; countryCode?: string | null } }>('/groups/regions', {
    onRequest: auth, config, schema: { body: { type: 'object', additionalProperties: false, required: ['machineGroupId', 'name'], properties: {
      machineGroupId: { type: 'integer', minimum: 1 }, name, countryCode
    } } }
  }, async (request, reply) => {
    if (!validHostGroup(request.body.name)) return reply.code(400).send({ code: 'HOST_GROUP_INVALID' })
    try {
      const group = await prisma.$transaction(async tx => {
        await lockHostGroups(tx)
        await tx.hostMachineGroup.findUniqueOrThrow({ where: { id: request.body.machineGroupId } })
        return tx.hostRegionGroup.create({ data: { ...request.body, name: request.body.name.trim() } })
      })
      await createLog(request.user.id, 'host', 'host.group.create', `Created region group #${group.id}`, 'success')
      return reply.code(201).send(group)
    } catch (error) { return groupError(error, reply) }
  })

  fastify.patch<{ Params: { id: number }; Body: { name: string; countryCode?: string | null } }>('/groups/regions/:id', {
    onRequest: auth, config, schema: { params, body: { ...machineBody, properties: { name, countryCode } } }
  }, async (request, reply) => {
    try {
      const group = await prisma.$transaction(tx => renameRegionGroup(tx, request.params.id, request.body.name, request.body.countryCode))
      await createLog(request.user.id, 'host', 'host.group.rename', `Renamed region group #${group.id}`, 'success')
      return group
    } catch (error) { return groupError(error, reply) }
  })

  fastify.delete<{ Params: { id: number } }>('/groups/regions/:id', { onRequest: auth, config, schema: { params } }, async (request, reply) => {
    try {
      await prisma.$transaction(tx => deleteRegionGroup(tx, request.params.id))
      await createLog(request.user.id, 'host', 'host.group.delete', `Deleted region group #${request.params.id}; hosts retained`, 'success')
      return { success: true }
    } catch (error) { return groupError(error, reply) }
  })
}
