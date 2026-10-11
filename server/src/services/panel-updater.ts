import { createConnection } from 'node:net'
import { UpdateError, isCommit } from '../lib/main-update.js'

export interface PanelUpdateExecution {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  sourceRepository: string
  mode: 'docker'
  targetCommit: string
  previousCommit: string | null
  phase: string
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  output: string
  error: string | null
  rollbackSucceeded?: boolean
}
export interface PanelUpdaterStatus {
  protocol: 1
  sourceRepository: string
  installDirectory: string
  execution: PanelUpdateExecution | null
}

/** The host socket accepts status/apply only; it cannot run commands or accept paths. */
export function panelUpdater(request: { action: 'status' } | { action: 'apply'; id: string; commit: string; repository: string }): Promise<PanelUpdaterStatus> {
  const path = process.env.INCUDAL_UPDATE_SOCKET?.trim()
  if (!path || !path.startsWith('/') || path.includes('\0')) return Promise.reject(new UpdateError('UPDATE_EXECUTOR_UNAVAILABLE'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let output = ''
    const fail = (code: string) => { socket.destroy(); reject(new UpdateError(code)) }
    socket.setTimeout(8000, () => fail('UPDATE_EXECUTOR_UNAVAILABLE'))
    socket.once('error', () => fail('UPDATE_EXECUTOR_UNAVAILABLE'))
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      output += chunk.toString('utf8')
      if (output.length > 65536) { fail('UPDATE_EXECUTOR_INVALID'); return }
      if (!output.includes('\n')) return
      socket.destroy()
      try {
        const response = JSON.parse(output.slice(0, output.indexOf('\n'))) as PanelUpdaterStatus & { code?: string }
        if (response.code) { reject(new UpdateError(/^UPDATE_[A-Z_]+$/.test(response.code) ? response.code : 'UPDATE_EXECUTOR_INVALID')); return }
        if (response.protocol !== 1 || typeof response.sourceRepository !== 'string' || typeof response.installDirectory !== 'string' ||
            (response.execution && (!isCommit(response.execution.targetCommit) || !['running', 'succeeded', 'failed'].includes(response.execution.status)))) throw new Error()
        resolve(response)
      } catch { reject(new UpdateError('UPDATE_EXECUTOR_INVALID')) }
    })
    socket.once('end', () => { if (!output.includes('\n')) fail('UPDATE_EXECUTOR_INVALID') })
  })
}
