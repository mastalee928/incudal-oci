import assert from 'node:assert/strict'
import {
  buildManualCommand,
  getAllowedRepositories,
  getPinnedUpdate,
  isAllowedRepository
} from '../src/lib/system-update-security.js'

const saved = { ...process.env }
try {
  delete process.env.INCUDAL_UPDATE_ALLOWED_REPOSITORIES
  assert.deepEqual(getAllowedRepositories(), ['mastalee928/incudal-oci'])
  assert.equal(isAllowedRepository('mastalee928/incudal-oci'), true)
  assert.equal(isAllowedRepository('1743986520/incudal'), false)

  process.env.INCUDAL_UPDATE_ALLOWED_REPOSITORIES = 'mastalee928/incudal-oci, trusted/example'
  assert.deepEqual(getAllowedRepositories(), ['mastalee928/incudal-oci', 'trusted/example'])
  assert.equal(isAllowedRepository('trusted/example'), true)
  assert.equal(isAllowedRepository('attacker/repo'), false)

  process.env.INCUDAL_UPDATE_REF = '0123456789abcdef0123456789abcdef01234567'
  process.env.INCUDAL_UPDATE_SCRIPT_SHA256 = 'a'.repeat(64)
  assert.deepEqual(getPinnedUpdate(), {
    ref: '0123456789abcdef0123456789abcdef01234567',
    scriptSHA256: 'a'.repeat(64)
  })

  process.env.INCUDAL_UPDATE_REF = 'main'
  assert.equal(getPinnedUpdate(), null)
  process.env.INCUDAL_UPDATE_REF = '0123456789abcdef0123456789abcdef01234567'
  process.env.INCUDAL_UPDATE_SCRIPT_SHA256 = 'not-a-digest'
  assert.equal(getPinnedUpdate(), null)

  process.env.INCUDAL_UPDATE_SCRIPT_SHA256 = 'b'.repeat(64)
  const command = buildManualCommand('mastalee928/incudal-oci', 'release')
  assert.match(command, /0123456789abcdef0123456789abcdef01234567/)
  assert.match(command, /sha256sum -c/)
  assert.match(command, /rm -f/)
  assert.doesNotMatch(command, /\/main\//)
  assert.doesNotMatch(command, /curl[^|]*\|\s*sudo bash/)

  console.log('system update security tests passed')
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  Object.assign(process.env, saved)
}
