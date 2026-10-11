import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchMainUpdate, mainCi, currentCommit, commitVersion, UpdateError } from '../src/lib/main-update.js'
import { normalizeGitHubRepository } from '../src/lib/system-update-security.js'
import { panelUpdater } from '../src/services/panel-updater.js'

const sha = 'a'.repeat(40), repo = 'mastalee928/incudal-oci'
test('panel updates resolve main commits without consulting Agent releases', async () => {
  const paths: string[] = []
  const result = await fetchMainUpdate(repo, (async url => {
    paths.push(String(url))
    return new Response(JSON.stringify(String(url).includes('/commits/') ? { sha, commit: { message: 'fix: fixture\n\nDetails', committer: { date: '2026-10-10T00:00:00Z' } } } :
      { workflow_runs: [{ id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] }))
  }) as typeof fetch)
  assert.equal(result.commit, sha)
  assert.equal(result.version, 'main@' + sha.slice(0, 12))
  assert.equal(result.ci.status, 'success')
  assert.equal(result.url, 'https://github.com/' + repo + '/commit/' + sha)
  assert.ok(paths.every(path => !path.includes('releases')))
})
test('CI approval must belong to the selected main push, and newer failures win', () => {
  const passed = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }
  assert.equal(mainCi([{ ...passed, head_sha: 'b'.repeat(40) }, { ...passed, event: 'pull_request' }], sha, repo).status, 'unknown')
  assert.equal(mainCi([passed, { ...passed, id: 2, conclusion: 'failure' }], sha, repo).status, 'failure')
  assert.equal(mainCi([{ ...passed, status: 'in_progress' }], sha, repo).status, 'pending')
})
test('inaccessible CI remains unknown and malformed commits fail closed', async () => {
  const result = await fetchMainUpdate(repo, (async url => String(url).includes('/commits/') ? new Response(JSON.stringify({ sha })) : new Response('', { status: 403 })) as typeof fetch)
  assert.equal(result.ci.status, 'unknown')
  await assert.rejects(fetchMainUpdate(repo, (async () => new Response(JSON.stringify({ sha: 'main' }))) as typeof fetch), error => error instanceof UpdateError && error.code === 'UPDATE_CHECK_FAILED')
})
test('unconfigured executor cannot fall back to arbitrary shell execution', async () => {
  const saved = process.env.INCUDAL_UPDATE_SOCKET
  delete process.env.INCUDAL_UPDATE_SOCKET
  try { await assert.rejects(panelUpdater({ action: 'status' }), error => error instanceof UpdateError && error.code === 'UPDATE_EXECUTOR_UNAVAILABLE') }
  finally { if (saved !== undefined) process.env.INCUDAL_UPDATE_SOCKET = saved }
  assert.equal(commitVersion(null), 'unknown')
  assert.ok(currentCommit() === null || /^[a-f0-9]{40}$/.test(currentCommit()!))
  assert.equal(normalizeGitHubRepository('https://example.com/owner/repo'), null)
})
