import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { createLog } from '../db/logs.js'
import { logAdminAction } from '../lib/security.js'
import { DEFAULT_GITHUB_REPOSITORY, getAllowedRepositories, isAllowedRepository, normalizeGitHubRepository } from '../lib/system-update-security.js'
import { currentCommit, commitVersion, fetchMainUpdate, isCommit, UpdateError } from '../lib/main-update.js'
import { panelUpdater } from '../services/panel-updater.js'

function repository(source?: string): string {
  const value = source ? normalizeGitHubRepository(source) : getAllowedRepositories()[0] || DEFAULT_GITHUB_REPOSITORY
  if (!value) throw new UpdateError('UPDATE_SOURCE_INVALID')
  if (!isAllowedRepository(value)) throw new UpdateError('UPDATE_SOURCE_NOT_ALLOWED')
  return value
}
function responseCode(error: unknown): string { return error instanceof UpdateError ? error.code : 'UPDATE_CHECK_FAILED' }
function errorStatus(code: string): number {
  return code === 'UPDATE_SOURCE_NOT_ALLOWED' ? 403 : code === 'UPDATE_CHECK_FAILED' ? 502 :
    ['UPDATE_CONFIRMATION_REQUIRED', 'UPDATE_SOURCE_INVALID', 'UPDATE_TARGET_INVALID', 'UPDATE_MODE_INVALID'].includes(code) ? 400 : 409
}
const sourceSchema = { type: 'string', maxLength: 200 }

export default async function systemUpdateRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticateAdmin]
  fastify.get<{ Querystring: { source?: string } }>('/status', {
    onRequest: auth, schema: { querystring: { type: 'object', properties: { source: sourceSchema } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const sourceRepository = repository(request.query.source)
      const updater = await panelUpdater({ action: 'status' }).catch(() => null)
      const commit = currentCommit()
      const executorAvailable = updater?.sourceRepository.toLowerCase() === sourceRepository.toLowerCase()
      // Installing the executor is a root step, so keep the exact command copyable
      // when the panel cannot run the update itself.
      const installDirectory = updater?.installDirectory || process.env.INCUDAL_INSTALL_DIR?.trim() || '/opt/incudal-oci'
      return { currentVersion: commitVersion(commit), currentCommit: commit, branch: 'main', sourceRepository,
        sourceUrl: 'https://github.com/' + sourceRepository, execution: updater?.execution || null,
        executorAvailable, installDirectory: updater?.installDirectory || null,
        manualCommand: executorAvailable ? null : `cd ${installDirectory} && sudo bash scripts/install-source.sh` }
    } catch (error) { const code = responseCode(error); return reply.code(errorStatus(code)).send({ code }) }
  })

  fastify.post<{ Body: { source?: string } }>('/check', {
    onRequest: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, properties: { source: sourceSchema } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const sourceRepository = repository(request.body?.source)
      const latest = await fetchMainUpdate(sourceRepository)
      const commit = currentCommit()
      return { currentVersion: commitVersion(commit), currentCommit: commit, sourceRepository,
        sourceUrl: 'https://github.com/' + sourceRepository, latest, updateAvailable: commit !== latest.commit }
    } catch (error) { const code = responseCode(error); return reply.code(errorStatus(code)).send({ code }) }
  })

  fastify.post<{ Body: { source?: string; commit?: string; confirm?: boolean; mode?: string } }>('/apply', {
    onRequest: auth, config: { rateLimit: { max: 2, timeWindow: '10 minutes' } },
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      source: sourceSchema, commit: { type: 'string', maxLength: 40 }, confirm: { type: 'boolean' }, mode: { type: 'string', maxLength: 20 }
    } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const body = request.body || {}
      if (body.confirm !== true) throw new UpdateError('UPDATE_CONFIRMATION_REQUIRED')
      if (!isCommit(body.commit)) throw new UpdateError('UPDATE_TARGET_INVALID')
      if (body.mode && !['auto', 'docker'].includes(body.mode)) throw new UpdateError('UPDATE_MODE_INVALID')
      const sourceRepository = repository(body.source)
      const latest = await fetchMainUpdate(sourceRepository)
      if (latest.commit !== body.commit) throw new UpdateError('UPDATE_TARGET_CHANGED')
      if (latest.ci.status !== 'success') throw new UpdateError('UPDATE_CI_NOT_PASSED')
      const id = randomUUID()
      await createLog(request.user.id, 'system', 'system.update_request', 'Panel update requested: ' + sourceRepository + '@' + body.commit, 'success')
      await logAdminAction(request.user.id, 'system.update_request', {
        ip: request.ip, userAgent: request.headers['user-agent'], resourceType: 'system_update',
        newValue: { sourceRepository, commit: body.commit }, metadata: { executionId: id }
      })
      const result = await panelUpdater({ action: 'apply', id, commit: body.commit, repository: sourceRepository })
      return reply.code(202).send({ accepted: true, execution: result.execution })
    } catch (error) { const code = responseCode(error); return reply.code(errorStatus(code)).send({ code }) }
  })
}
