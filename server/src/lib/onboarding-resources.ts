import { OnboardingError, type OnboardingDefaults, type ResourcePreset } from './host-onboarding.js'

export interface HostResourceProbe {
  architecture: 'x86_64' | 'aarch64'
  cpuCount: number
  memoryMiB: number
  diskTotalBytes: string
  diskAvailableBytes: string
  diskSwapMiB: number
}
export interface ResolvedHostResources {
  version: 1
  detectedAt: string
  probe: HostResourceProbe
  resourcePreset: ResourcePreset | null
  cpuAllowanceMax: number
  memoryMax: number
  customerDiskGiB: number | null
  storageSize: number
  memoryReserveMiB: number
  diskReserveGiB: number
}

export function parseResourceProbe(output: string): HostResourceProbe {
  let data: HostResourceProbe
  try { data = JSON.parse(output.trim()) } catch { throw new OnboardingError('RESOURCE_PROBE_INVALID') }
  if (!data || !['x86_64', 'aarch64'].includes(data.architecture) ||
      !Number.isInteger(data.cpuCount) || data.cpuCount < 1 || data.cpuCount > 4096 ||
      !Number.isInteger(data.memoryMiB) || data.memoryMiB < 1 || data.memoryMiB > 16777216 ||
      !Number.isInteger(data.diskSwapMiB) || data.diskSwapMiB < 0 ||
      !/^\d{1,20}$/.test(String(data.diskTotalBytes)) || !/^\d{1,20}$/.test(String(data.diskAvailableBytes))) throw new OnboardingError('RESOURCE_PROBE_INVALID')
  if (BigInt(data.diskAvailableBytes) > BigInt(data.diskTotalBytes)) throw new OnboardingError('RESOURCE_PROBE_INVALID')
  return data
}

/** Customer quotas never include swap or the pool's image/filesystem reserve. */
export function resolveHostResources(probe: HostResourceProbe, input: OnboardingDefaults): ResolvedHostResources {
  const preset = input.resourcePreset || null
  if (preset && probe.architecture !== (preset === 'E2' ? 'x86_64' : 'aarch64')) throw new OnboardingError('RESOURCE_ARCHITECTURE_MISMATCH')
  // Oracle x86 shapes count one OCPU as two logical CPUs (SMT threads), while
  // Ampere A1 counts one OCPU as one core.
  const cores = preset === 'E2' ? 2 : preset ? Number(preset[3]) : probe.cpuCount
  const cpuAllowanceMax = preset ? cores * 100 : input.cpuAllowanceMax ?? cores * 100
  if (cpuAllowanceMax > probe.cpuCount * 100) throw new OnboardingError('RESOURCE_CPU_INSUFFICIENT')
  const autoReserve = Math.max(192, Math.ceil(probe.memoryMiB * 0.2))
  const memoryMax = preset === 'E2' ? 768 : preset ? cores * 4096 : input.memoryMax ?? Math.floor((probe.memoryMiB - autoReserve) / 64) * 64
  const minimumReserve = probe.memoryMiB < 1024 ? 128 : 192
  if (memoryMax < 256 || memoryMax + minimumReserve > probe.memoryMiB) throw new OnboardingError('RESOURCE_MEMORY_INSUFFICIENT')
  // Old jobs used storageSize as the backing pool size, not a customer promise.
  const legacyPool = !preset && input.customerDiskGiB === undefined && input.storageSize !== undefined
  const customerDiskGiB = legacyPool ? null : input.customerDiskGiB ?? 30
  const storageSize = legacyPool ? input.storageSize! : customerDiskGiB! + Math.max(4, Math.ceil(customerDiskGiB! * 0.1))
  const diskReserveGiB = 4
  const newSwapGiB = probe.diskSwapMiB >= 1023 ? 0 : 1
  if (BigInt(probe.diskAvailableBytes) < BigInt(storageSize + diskReserveGiB + newSwapGiB) * 1073741824n) throw new OnboardingError('RESOURCE_DISK_INSUFFICIENT')
  return { version: 1, detectedAt: new Date().toISOString(), probe, resourcePreset: preset, cpuAllowanceMax, memoryMax,
    customerDiskGiB, storageSize, memoryReserveMiB: probe.memoryMiB - memoryMax, diskReserveGiB }
}
