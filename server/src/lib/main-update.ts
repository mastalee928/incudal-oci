import { readFileSync } from 'node:fs'

export class UpdateError extends Error {
  constructor(public readonly code: string) { super(code) }
}
export const isCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
export type CiStatus = 'success' | 'pending' | 'failure' | 'unknown'
export interface MainUpdate {
  version: string
  commit: string
  branch: 'main'
  name: string
  notes: string
  url: string
  publishedAt: string | null
  ci: { status: CiStatus; url: string | null }
}

export function currentCommit(): string | null {
  // Read the image's build metadata, never the checkout or package.json version.
  try {
    const data = JSON.parse(readFileSync(new URL('../../build-info.json', import.meta.url), 'utf8'))
    if (isCommit(data.commit)) return data.commit
  } catch { /* Source development and older images may not have build metadata. */ }
  return null
}
export function commitVersion(commit: string | null): string { return commit ? 'main@' + commit.slice(0, 12) : 'unknown' }

interface WorkflowRun { id?: number; head_sha?: string; head_branch?: string; event?: string; status?: string; conclusion?: string; run_attempt?: number }
export function mainCi(runs: WorkflowRun[], commit: string, repository: string): MainUpdate['ci'] {
  const run = runs.filter(run => run.head_sha === commit && run.head_branch === 'main' && run.event === 'push')
    .sort((a, b) => (b.id || 0) - (a.id || 0) || (b.run_attempt || 0) - (a.run_attempt || 0))[0]
  if (!run) return { status: 'unknown', url: null }
  return { status: run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'success' : 'failure',
    url: Number.isSafeInteger(run.id) && run.id! > 0 ? `https://github.com/${repository}/actions/runs/${run.id}` : null }
}

export async function fetchMainUpdate(repository: string, fetcher: typeof fetch = fetch): Promise<MainUpdate> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Incudal-Panel-Update' }
  const token = process.env.INCUDAL_UPDATE_GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = 'Bearer ' + token
  const get = async (path: string) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw new UpdateError('UPDATE_CHECK_FAILED')
    return response.json()
  }
  const data = await get('commits/main') as { sha?: unknown; commit?: { message?: string; committer?: { date?: string } } }
  if (!isCommit(data.sha)) throw new UpdateError('UPDATE_CHECK_FAILED')
  let ci: MainUpdate['ci'] = { status: 'unknown', url: null }
  try {
    const workflows = await get(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${data.sha}&per_page=20`) as { workflow_runs?: WorkflowRun[] }
    if (Array.isArray(workflows.workflow_runs)) ci = mainCi(workflows.workflow_runs, data.sha, repository)
  } catch { /* Display unknown CI and disable updates when checks are inaccessible. */ }
  const notes = typeof data.commit?.message === 'string' ? data.commit.message.slice(0, 6000) : ''
  return { commit: data.sha, version: commitVersion(data.sha), branch: 'main', name: notes.split('\n')[0] || data.sha.slice(0, 12),
    notes, url: `https://github.com/${repository}/commit/${data.sha}`, publishedAt: data.commit?.committer?.date || null, ci }
}
