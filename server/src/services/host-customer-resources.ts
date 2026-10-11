import { prisma } from '../db/prisma.js'

/** Check before touching Incus: shrinking a disk back after a rejected DB write
 * is not a reliable rollback. Legacy non-increasing changes remain allowed. */
export async function assertHostCustomerResources(hostId: number, incusId: string, resources: { cpu?: number; memory?: number; disk?: number }) {
  const host = await prisma.host.findUnique({ where: { id: hostId }, select: {
    singleTenant: true, cpuAllowanceMax: true, memoryMax: true, customerDiskGiB: true,
    instances: { where: { incusId }, select: { cpu: true, memory: true, disk: true }, take: 1 }
  } })
  if (!host?.singleTenant) return false
  const previous = host.instances[0]
  const limits = { cpu: host.cpuAllowanceMax, memory: host.memoryMax, disk: host.customerDiskGiB === null ? null : host.customerDiskGiB * 1024 }
  for (const kind of ['cpu', 'memory', 'disk'] as const) {
    const value = resources[kind], limit = limits[kind]
    if (value !== undefined && limit !== null && value > limit && (!previous || value > previous[kind])) {
      throw Object.assign(new Error('HOST_CUSTOMER_' + kind.toUpperCase() + '_EXCEEDED'), { code: 'HOST_RESOURCES_INSUFFICIENT', statusCode: 409 })
    }
  }
  return true
}

/** Dedicated inventory quotas are MiB. Preserve the legacy payload format for
 * other hosts while making 768 MiB / 4 GiB / 30 GiB exact on new inventory. */
export async function prepareHostInstanceConfig(hostId: number, input: unknown): Promise<unknown> {
  const host = await prisma.host.findUnique({ where: { id: hostId }, select: { singleTenant: true } })
  if (!host?.singleTenant || !input || typeof input !== 'object') return input
  const body = input as Record<string, any>
  const binary = (value: unknown) => typeof value === 'string' && /^\d+MB$/.test(value) ? value.replace(/MB$/, 'MiB') : value
  return { ...body,
    ...(body.config ? { config: { ...body.config, ...(body.config['limits.memory'] !== undefined ? { 'limits.memory': binary(body.config['limits.memory']) } : {}) } } : {}),
    ...(body.devices?.root ? { devices: { ...body.devices, root: { ...body.devices.root, ...(body.devices.root.size !== undefined ? { size: binary(body.devices.root.size) } : {}) } } } : {})
  }
}
