import assert from 'node:assert/strict'
import test from 'node:test'
import { parseResourceProbe, resolveHostResources, type HostResourceProbe } from '../src/lib/onboarding-resources.js'
import { OnboardingError, validateOnboardingInput, type ResourcePreset } from '../src/lib/host-onboarding.js'
import { parseHostOnboardingCsv } from '../../client/src/utils/hostOnboardingCsv.js'

const probe = (changes: Partial<HostResourceProbe> = {}): HostResourceProbe => ({ architecture: 'x86_64', cpuCount: 2,
  memoryMiB: 966, diskTotalBytes: String(48n * 1073741824n), diskAvailableBytes: String(46n * 1073741824n), diskSwapMiB: 0, ...changes })
const defaults = { countryCode: 'us', portProtocol: 'tcp_udp' as const }
const error = (fn: () => unknown, code: string) => assert.throws(fn, value => value instanceof OnboardingError && value.code === code)

test('E2 reserves host memory on both measured E2 sizes and separates customer disk from its pool', () => {
  for (const memoryMiB of [951, 966]) {
    const value = resolveHostResources(probe({ memoryMiB }), { ...defaults, resourcePreset: 'E2', customerDiskGiB: 30 })
    assert.equal(value.memoryMax, 768)
    assert.equal(value.cpuAllowanceMax, 200)
    assert.equal(value.memoryReserveMiB, memoryMiB - 768)
    assert.equal(value.customerDiskGiB, 30)
    assert.equal(value.storageSize, 34)
  }
})
test('all ARM presets retain fixed RAM and independent customer disk choices', () => {
  for (const cores of [1, 2, 3, 4]) {
    for (const customerDiskGiB of [30, 60, 90, 120, 73]) {
      const host = probe({ architecture: 'aarch64', cpuCount: cores, memoryMiB: 5940 * cores, diskTotalBytes: String(256n * 1073741824n), diskAvailableBytes: String(240n * 1073741824n) })
      const value = resolveHostResources(host, { ...defaults, resourcePreset: ('ARM' + cores + 'C') as ResourcePreset, customerDiskGiB })
      assert.equal(value.cpuAllowanceMax, cores * 100)
      assert.equal(value.memoryMax, cores * 4096)
      assert.equal(value.customerDiskGiB, customerDiskGiB)
      assert.ok(value.storageSize > customerDiskGiB)
    }
  }
})
test('auto mode uses physical memory, leaves overhead and never counts swap as RAM', () => {
  const a = resolveHostResources(probe(), defaults)
  const b = resolveHostResources(probe({ diskSwapMiB: 4096 }), defaults)
  assert.equal(a.memoryMax, 768)
  assert.equal(a.memoryMax, b.memoryMax)
  assert.equal(a.cpuAllowanceMax, 200)
  assert.equal(a.customerDiskGiB, 30)
})
test('preset mismatch and insufficient physical resources fail without lowering quotas', () => {
  error(() => resolveHostResources(probe(), { ...defaults, resourcePreset: 'ARM1C' }), 'RESOURCE_ARCHITECTURE_MISMATCH')
  error(() => resolveHostResources(probe({ architecture: 'aarch64', memoryMiB: 23991 }), { ...defaults, resourcePreset: 'ARM4C' }), 'RESOURCE_CPU_INSUFFICIENT')
  error(() => resolveHostResources(probe({ memoryMiB: 850 }), { ...defaults, resourcePreset: 'E2' }), 'RESOURCE_MEMORY_INSUFFICIENT')
  error(() => resolveHostResources(probe(), { ...defaults, resourcePreset: 'E2', customerDiskGiB: 60 }), 'RESOURCE_DISK_INSUFFICIENT')
  const diskAvailableBytes = String(38n * 1073741824n)
  error(() => resolveHostResources(probe({ diskAvailableBytes }), defaults), 'RESOURCE_DISK_INSUFFICIENT')
  assert.equal(resolveHostResources(probe({ diskAvailableBytes, diskSwapMiB: 1023 }), defaults).customerDiskGiB, 30)
})
test('legacy pool sizes are preserved without inventing a customer disk promise', () => {
  const value = resolveHostResources(probe(), { ...defaults, cpuAllowanceMax: 200, memoryMax: 768, storageSize: 30 })
  assert.equal(value.customerDiskGiB, null)
  assert.equal(value.storageSize, 30)
  assert.equal(value.memoryMax, 768)
})
test('hardware probes and new form fields reject malformed values', () => {
  assert.deepEqual(parseResourceProbe(JSON.stringify(probe())), probe())
  error(() => parseResourceProbe('unexpected output'), 'RESOURCE_PROBE_INVALID')
  error(() => parseResourceProbe(JSON.stringify(probe({ diskAvailableBytes: '99999999999999999999' }))), 'RESOURCE_PROBE_INVALID')
  const request = { requestId: '01234567-0123-0123-0123-012345678901', name: 'fixture', accountLabel: '', defaults,
    credentials: { password: 'fixture-only' }, nodes: [{ name: 'fixture', publicIp: '8.8.8.8' }] }
  assert.doesNotThrow(() => validateOnboardingInput(request))
  error(() => validateOnboardingInput({ ...request, defaults: { ...defaults, customerDiskGiB: 0 } }), 'CUSTOMER_DISK_INVALID')
  error(() => validateOnboardingInput({ ...request, defaults: { ...defaults, resourcePreset: 'ARM5C' } }), 'RESOURCE_PRESET_INVALID')
})
test('CSV supports per-node specifications, explicit AUTO and custom disks', () => {
  const rows = parseHostOnboardingCsv('name,publicIp,resourcePreset,customerDiskGiB\none,8.8.8.8,ARM3C,90\ntwo,1.1.1.1,AUTO,73\nthree,9.9.9.9,,')
  assert.equal(rows[0].resourcePreset, 'ARM3C')
  assert.equal(rows[0].customerDiskGiB, 90)
  assert.equal(rows[1].resourcePreset, null)
  assert.equal(rows[1].customerDiskGiB, 73)
  assert.equal(rows[2].resourcePreset, undefined)
  assert.throws(() => parseHostOnboardingCsv('name,publicIp,customerDiskGiB\none,8.8.8.8,1e3'))
})
