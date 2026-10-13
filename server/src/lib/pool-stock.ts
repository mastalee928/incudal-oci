/**
 * 一机一卖池子的库存判据（单一来源）。
 *
 * 管理端「机子池/定价表」与客户公开目录必须用同一套「能卖」定义，否则会出现
 * 「后台显示有未售机器、客户却看到售罄」。真相判据与分配器
 * `selectAvailableHost` 一致：**单租户 + 就绪**（`dedicatedHostReadyWhere`）。
 *
 * 池子 = 机型分组 + 核心数 + 地区分组 + 硬盘档；四元组任一不同就是另一个商品。
 */
import type { Prisma } from '@prisma/client'
import { dedicatedHostReadyWhere } from './host-resource-usage.js'

export { HOST_OCCUPIED_INSTANCE_WHERE } from './host-resource-usage.js'

/** 能进入一机一卖池子的宿主机：单租户 + 就绪。 */
export const POOL_HOST_WHERE: Prisma.HostWhereInput = {
  singleTenant: true,
  ...dedicatedHostReadyWhere()
}

export interface PoolKey {
  machineGroupId: number
  resourcePreset: string | null
  regionGroupId: number | null
  diskGiB: number | null
}

export function poolKeyOf(host: {
  machineGroupId: number | null
  resourcePreset: string | null
  regionGroupId: number | null
  customerDiskGiB: number | null
}): PoolKey {
  return {
    machineGroupId: host.machineGroupId ?? 0,
    resourcePreset: host.resourcePreset,
    regionGroupId: host.regionGroupId,
    diskGiB: host.customerDiskGiB
  }
}

export function poolKeyString(key: PoolKey): string {
  return [key.machineGroupId, key.resourcePreset, key.regionGroupId, key.diskGiB].join('|')
}

export function priceKeyOf(price: {
  machineGroupId: number
  resourcePreset: string
  regionGroupId: number
  diskGiB: number
}): string {
  return [price.machineGroupId, price.resourcePreset, price.regionGroupId, price.diskGiB].join('|')
}

/** 一台机器不可售的原因；可售时为 null。 */
export type UnsellableReason = 'assigned' | 'no-spec' | 'not-single-tenant' | 'not-ready' | 'no-price'

/**
 * 判断一台机器的可售状态。调用方提供占用/就绪/是否有对应定价行这三项事实，
 * 这里只做「原因」的判定与排序，保证界面文案与管理端/客户目录口径一致。
 */
export function unsellableReason(facts: {
  occupied: boolean
  resourcePreset: string | null
  customerDiskGiB: number | null
  singleTenant: boolean
  ready: boolean
  hasPrice: boolean
}): UnsellableReason | null {
  if (facts.occupied) return 'assigned'
  if (!facts.resourcePreset || facts.customerDiskGiB === null) return 'no-spec'
  if (!facts.singleTenant) return 'not-single-tenant'
  if (!facts.ready) return 'not-ready'
  if (!facts.hasPrice) return 'no-price'
  return null
}
