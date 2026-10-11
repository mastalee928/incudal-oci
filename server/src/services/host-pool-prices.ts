import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { OnboardingError, RESOURCE_PRESETS, type ResourcePreset } from '../lib/host-onboarding.js'
import { presetQuota } from '../lib/onboarding-resources.js'
import { HOST_OCCUPIED_INSTANCE_WHERE, dedicatedHostReadyWhere } from '../lib/host-resource-usage.js'
import { lockHostGroups } from './host-groups.js'

type DbClient = Prisma.TransactionClient | typeof prisma

/** 影子套餐名。Package 上有 @@unique([userId, name])，加前缀避免与真实套餐重名。 */
const shadowPackageName = (preset: string) => `[池子] ${preset}`

/** 影子方案名。PackagePlan 上有 @@unique([packageId, name])，用价格行 ID 保证唯一。 */
const shadowPlanName = (poolPriceId: number) => `池子 #${poolPriceId}`

/**
 * 「事实无限」的流量占位值：1 EiB。
 * `PackagePlan.trafficLimit` 是必填，而创建路径会把它原样复制到实例的
 * `monthlyTrafficLimit` 上——填 0 会让客户实例立刻流量超限，所以必须给大值。
 * 一机一卖不按流量结算，这个值不会被真正消耗。
 */
const UNLIMITED_TRAFFIC = 1n << 60n

export interface PoolPriceInput {
  machineGroupId: number
  resourcePreset: ResourcePreset
  regionGroupId: number
  diskGiB: number
  name?: string | null
  monthlyPrice: number // 分
  setupFee: number // 分
  active?: boolean
  sortOrder?: number
}

export interface PoolInventoryRow {
  machineGroupId: number
  resourcePreset: string | null
  regionGroupId: number | null
  diskGiB: number | null
  total: number
  idle: number
}

function validateInput(input: PoolPriceInput): void {
  if (!RESOURCE_PRESETS.includes(input.resourcePreset)) throw new OnboardingError('POOL_PRESET_INVALID')
  if (!Number.isInteger(input.diskGiB) || input.diskGiB < 10 || input.diskGiB > 10000) throw new OnboardingError('POOL_DISK_INVALID')
  for (const value of [input.monthlyPrice, input.setupFee]) {
    if (!Number.isInteger(value) || value < 0 || value > 9999999999) throw new OnboardingError('POOL_PRICE_INVALID')
  }
  if (input.name !== undefined && input.name !== null && (typeof input.name !== 'string' || input.name.length > 60)) {
    throw new OnboardingError('POOL_NAME_INVALID')
  }
}

/**
 * 影子套餐：每个「核心数预设」一条，hidden=true，不出现在任何界面。
 * 它存在的唯一理由是让 Instance.packageId 与既有计费/优惠券/统计逻辑继续工作。
 * 只按预设索引、不含机型分组：机型分组对下游没有任何影响。
 */
async function ensureShadowPackage(tx: DbClient, preset: ResourcePreset, ownerId: number, diskGiB: number) {
  const name = shadowPackageName(preset)
  // 按名称查找而不是按所有者：两个管理员先后保存同一个预设时不应各建一条。
  const existing = await tx.package.findFirst({ where: { name, hidden: true } })
  const quota = presetQuota(preset)
  // cpuMax / memoryMax / diskMax 只在「没有方案」的免费套餐路径上生效；
  // 影子套餐永远配有方案，所以这三个值对实例没有影响，仅为满足非空约束。
  const data = {
    cpuMax: quota.cpuAllowanceMax,
    memoryMax: quota.memoryMax,
    diskMax: diskGiB * 1024,
    portLimit: 0,
    snapshotLimit: 0,
    backupLimit: 0,
    siteLimit: 0,
    monthlyTrafficLimit: null, // null = 不限
    hidden: true,
    active: true,
    // 必须公开：canUserAccessPackage 只放行「自己的套餐」与「globalShared 的套餐」，
    // 影子套餐归管理员所有，不设为公开客户就会在下单入口拿到 403。
    // 旧的市场接口因此要过滤 hidden，避免影子套餐漏进旧页面。
    globalShared: true
  }
  if (existing) return tx.package.update({ where: { id: existing.id }, data })
  return tx.package.create({ data: { userId: ownerId, name, description: '系统生成的池子套餐，不对用户展示', ...data } })
}

/**
 * 影子方案：每个池子行一条，价格与初装费直接镜像自定价表。
 * 创建路径只读方案，所以这里的每个字段都必须是「一机一卖下的正确值」。
 */
async function ensureShadowPlan(tx: DbClient, packageId: number, row: { id: number; resourcePreset: string; diskGiB: number; monthlyPrice: Prisma.Decimal; setupFee: Prisma.Decimal }) {
  const quota = presetQuota(row.resourcePreset as ResourcePreset)
  const name = shadowPlanName(row.id)
  const data = {
    cpu: quota.cpuAllowanceMax,
    memory: quota.memoryMax,
    disk: row.diskGiB * 1024, // 实例侧磁盘单位是 MiB
    portLimit: 0, // 全端口直连，不需要在面板加端口，因此不预占端口数
    snapshotLimit: 0,
    backupLimit: 0,
    siteLimit: 0,
    swapSize: 0,
    trafficLimit: UNLIMITED_TRAFFIC,
    trafficLimitSpeed: '0', // '0' 是「不加带宽限制」的哨兵值，创建路径只在 !== '0' 时套用限速
    trafficBillingMode: 'package' as const,
    billingMode: 'package' as const,
    price: row.monthlyPrice,
    billingCycle: 1,
    setupFee: row.setupFee,
    isActive: true,
    isSoldOut: false,
    sortOrder: 0
  }
  const existing = await tx.packagePlan.findFirst({ where: { packageId, name } })
  if (existing) return tx.packagePlan.update({ where: { id: existing.id }, data })
  return tx.packagePlan.create({ data: { packageId, name, ...data } })
}

/**
 * Prisma 的 Decimal 会序列化成字符串，而仓库既有做法是转成 Number 再返回
 * （见 routes/packages.ts 的 `Number(plan.setupFee)`）。价格单位是分、都是整数，
 * 转 Number 不会丢精度。不转换的话前端会拿到字符串，算价时静默出错。
 */
export function serializePoolPrice<T extends { monthlyPrice: Prisma.Decimal; setupFee: Prisma.Decimal }>(row: T) {
  return { ...row, monthlyPrice: Number(row.monthlyPrice), setupFee: Number(row.setupFee) }
}

/** 写入单行定价 + 影子套餐/方案。调用方必须已持有分组锁与事务。 */
async function writePoolPrice(tx: DbClient, input: PoolPriceInput, ownerId: number): Promise<number> {
  const machine = await tx.hostMachineGroup.findUnique({ where: { id: input.machineGroupId } })
  if (!machine) throw new OnboardingError('HOST_GROUP_NOT_FOUND')
  const region = await tx.hostRegionGroup.findUnique({ where: { id: input.regionGroupId } })
  if (!region) throw new OnboardingError('HOST_GROUP_NOT_FOUND')
  if (region.machineGroupId !== machine.id) throw new OnboardingError('HOST_GROUP_MISMATCH')

  const key = {
    machineGroupId: input.machineGroupId,
    resourcePreset: input.resourcePreset,
    regionGroupId: input.regionGroupId,
    diskGiB: input.diskGiB
  }
  const name = input.name?.trim() || null
  const saved = await tx.hostPoolPrice.upsert({
    // 复合唯一约束在 schema 里用了自定义名，Prisma 生成的 where 键就是该约束名本身
    where: { host_pool_prices_pool_key: key },
    create: { ...key, name, monthlyPrice: input.monthlyPrice, setupFee: input.setupFee, active: input.active ?? true, sortOrder: input.sortOrder ?? 0 },
    update: {
      name,
      monthlyPrice: input.monthlyPrice,
      setupFee: input.setupFee,
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder })
    }
  })

  const shadowPackage = await ensureShadowPackage(tx, input.resourcePreset, ownerId, input.diskGiB)
  await ensureShadowPlan(tx, shadowPackage.id, saved)
  return saved.id
}

/** 新增或更新一个池子商品。影子套餐与影子方案在同一事务内跟进。 */
export async function upsertPoolPrice(input: PoolPriceInput, ownerId: number) {
  validateInput(input)
  const id = await prisma.$transaction(async tx => {
    // 与分组改名/删除串行，避免「地区正在被删」的同时还在给它定价
    await lockHostGroups(tx)
    return writePoolPrice(tx, input, ownerId)
  })
  const row = await prisma.hostPoolPrice.findUniqueOrThrow({ where: { id } })
  return { price: serializePoolPrice(row) }
}

/**
 * 批量保存定价表：一屏几十格一次提交。
 * 全部在同一个事务里，避免「保存到一半」留下半套价格。
 */
export async function upsertPoolPrices(items: PoolPriceInput[], ownerId: number) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw new OnboardingError('POOL_BATCH_INVALID')
  for (const item of items) validateInput(item)
  return prisma.$transaction(async tx => {
    await lockHostGroups(tx)
    const ids: number[] = []
    for (const item of items) ids.push(await writePoolPrice(tx, item, ownerId))
    return { saved: ids.length, ids }
  })
}

/** 下架并删除一个池子商品，连同它的影子方案。已有实例不受影响：它们存着自己的价格。 */
export async function deletePoolPrice(id: number) {
  return prisma.$transaction(async tx => {
    await lockHostGroups(tx)
    const row = await tx.hostPoolPrice.findUnique({ where: { id } })
    if (!row) throw new OnboardingError('POOL_PRICE_NOT_FOUND')
    const shadowPackage = await tx.package.findFirst({ where: { name: shadowPackageName(row.resourcePreset), hidden: true } })
    if (shadowPackage) await tx.packagePlan.deleteMany({ where: { packageId: shadowPackage.id, name: shadowPlanName(id) } })
    await tx.hostPoolPrice.delete({ where: { id } })
    return { success: true }
  })
}

/**
 * 把池子商品解析成「影子套餐 + 影子方案」，供下单路径复用既有的创建流程。
 *
 * 这是影子机制的关键一环：解析出 id 之后，创建路径的计费、优惠券、AFF、到期
 * 全部照旧工作，不需要为池子模型改任何一条。
 */
export async function resolvePoolProduct(poolPriceId: number) {
  const price = await prisma.hostPoolPrice.findUnique({ where: { id: poolPriceId } })
  if (!price || !price.active) return null
  const shadowPackage = await prisma.package.findFirst({ where: { name: shadowPackageName(price.resourcePreset), hidden: true } })
  if (!shadowPackage) return null
  const shadowPlan = await prisma.packagePlan.findFirst({ where: { packageId: shadowPackage.id, name: shadowPlanName(price.id) } })
  if (!shadowPlan) return null
  return { price, packageId: shadowPackage.id, planId: shadowPlan.id }
}

/** 定价表：某个机型 + 核心下的全部行（含未上架的），供管理端渲染矩阵。 */
export async function listPoolPrices(machineGroupId?: number, resourcePreset?: string) {
  const rows = await prisma.hostPoolPrice.findMany({
    where: { ...(machineGroupId === undefined ? {} : { machineGroupId }), ...(resourcePreset === undefined ? {} : { resourcePreset }) },
    include: { regionGroup: { select: { id: true, name: true, countryCode: true } }, machineGroup: { select: { id: true, name: true } } },
    orderBy: [{ resourcePreset: 'asc' }, { diskGiB: 'asc' }, { id: 'asc' }]
  })
  return rows.map(serializePoolPrice)
}

/**
 * 每个池子的库存：总台数与空闲台数。
 *
 * `readyOnly` 决定口径，两种用途必须分清：
 * - 管理端定价页用 false：你给「池子」定价，不是给当前就绪的那几台定价，
 *   机器离线也该看得见。
 * - 购买页用 true：必须与分配器 `selectAvailableHost` 用**同一套就绪判据**，
 *   否则会出现「页面显示有货、下单却挑不到机器」。
 */
export async function poolInventory(options: { readyOnly?: boolean } = {}): Promise<PoolInventoryRow[]> {
  const hosts = await prisma.host.findMany({
    where: { singleTenant: true, ...(options.readyOnly ? dedicatedHostReadyWhere() : {}) },
    select: {
      machineGroupId: true,
      resourcePreset: true,
      regionGroupId: true,
      customerDiskGiB: true,
      _count: { select: { instances: { where: HOST_OCCUPIED_INSTANCE_WHERE } } }
    }
  })
  const byPool = new Map<string, PoolInventoryRow>()
  for (const host of hosts) {
    const row: PoolInventoryRow = {
      machineGroupId: host.machineGroupId ?? 0,
      resourcePreset: host.resourcePreset,
      regionGroupId: host.regionGroupId,
      diskGiB: host.customerDiskGiB,
      total: 0,
      idle: 0
    }
    const key = [row.machineGroupId, row.resourcePreset, row.regionGroupId, row.diskGiB].join('|')
    const entry = byPool.get(key) ?? row
    entry.total += 1
    if (host._count.instances === 0) entry.idle += 1
    byPool.set(key, entry)
  }
  return [...byPool.values()]
}
