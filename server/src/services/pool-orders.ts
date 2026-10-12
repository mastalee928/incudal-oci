/**
 * 一机一卖的多台订单：购物车结算与「直接付款」共用的唯一下单路径。
 *
 * 规则（已与产品确认）：
 *   - 整单全有或全无：任何一台预占不到，整单回滚、一分钱不扣，逐行回报缺口。
 *   - 先付先得：加购不占库存，占库存的只有这里的事务。
 *   - 事务里只做数据库操作；IP 预留、cloud-init、存储池、Incus 开通全部在提交之后逐台执行。
 *   - 按 poolPriceId 升序预占，所有事务加锁顺序一致，跨商品订单不会互相死锁。
 *   - 账单仍然每台一条 newPurchase（月费 + 初装费），退租、退款、续费、到期全部沿用。
 */
import { Prisma } from '@prisma/client'
import { customAlphabet } from 'nanoid'
import * as db from '../db/index.js'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { calculateCreateBilling } from '../db/billing-operations.js'
import { getPlanById } from '../db/package-plans.js'
import { getSystemConfigNumber } from '../db/system-config.js'
import { isImageCompatibleWithMemory } from '../db/images.js'
import { validateCommandsOwnership, mergeCommandContents, getImageDistroFromAlias } from '../db/custom-init-commands.js'
import { ErrorCode, type ErrorCodeType } from '../lib/errors.js'
import { generateIncusConfig, generateRandomPassword } from '../lib/incus-config-generator.js'
import { encryptSensitiveData, validateName } from '../lib/security.js'
import { resolveInstanceTrafficLimitForHost } from '../lib/traffic-multiplier.js'
import { sendNotification } from '../lib/notifier.js'
import { createInstanceAsync } from '../routes/instances/create-async.js'
import { normalizePlanTrafficLimitSpeed } from './traffic-bandwidth.js'
import { poolInventory, resolvePoolProduct } from './host-pool-prices.js'

const shortId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8)
const batchIdGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12)

const DEFAULT_MAX_INSTANCES = 100
const NETWORK_MODES = ['nat', 'nat_ipv6', 'nat_ipv6_nat', 'ipv6_only', 'ipv6_nat'] as const
type NetworkMode = typeof NETWORK_MODES[number]

export interface PoolOrderItemInput {
  poolPriceId: number
  quantity: number
  namePrefix: string
  image: string
  customInitCommandIds?: number[]
}

export interface PoolOrderInput {
  items: PoolOrderItemInput[]
  sshKeyId: number
  /** 前端按购物车展示价算出的整单总额（分），用于拦住「加购后改价」。 */
  expectedTotal: number
}

export interface PoolOrderResult {
  batchId: string
  /** 实际扣款总额（分） */
  total: number
  instances: Array<{
    id: number
    name: string
    incusId: string
    host: string
    status: 'creating'
    sshPort: number | null
    rootPassword: string
  }>
}

export class PoolOrderError extends Error {
  constructor(
    public readonly code: ErrorCodeType,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'PoolOrderError'
  }
}

/** 池子的系统架构由机型决定：E2 是 x86，ARM 各核心是 aarch64。与前端的推导保持一致。 */
function architectureOfPreset(preset: string): 'x86_64' | 'aarch64' {
  return preset.startsWith('ARM') ? 'aarch64' : 'x86_64'
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

interface PlannedInstance {
  name: string
  incusId: string
  rootPassword: string
  sshPort: number | null
  configPayload: Record<string, string>
  extraShellCommands?: string
}

interface ResolvedItem {
  input: PoolOrderItemInput
  product: NonNullable<Awaited<ReturnType<typeof resolvePoolProduct>>>
  pkg: NonNullable<Awaited<ReturnType<typeof db.getPackageById>>>
  plan: NonNullable<Awaited<ReturnType<typeof getPlanById>>>
  billing: ReturnType<typeof calculateCreateBilling>
  networkMode: NetworkMode
  planned: PlannedInstance[]
}

/** 名字：一台时就是客户填的名字，多台时「前缀-01」起编号。 */
function buildInstanceNames(prefix: string, quantity: number): string[] {
  if (quantity === 1) return [prefix]
  const width = Math.max(2, String(quantity).length)
  return Array.from({ length: quantity }, (_, index) => `${prefix}-${String(index + 1).padStart(width, '0')}`)
}

/**
 * 事务之前的全部校验与定价。失败即抛错，此时还没有锁任何机器。
 */
async function prepareOrder(userId: number, input: PoolOrderInput, sshKey: string): Promise<{ items: ResolvedItem[]; totalYuan: number; totalCount: number }> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new PoolOrderError(ErrorCode.POOL_ORDER_INVALID, '订单为空')
  }

  const maxInstances = Math.max(1, Math.floor(await getSystemConfigNumber('pool_order_max_instances', DEFAULT_MAX_INSTANCES)))
  const totalCount = input.items.reduce((sum, item) => sum + item.quantity, 0)
  if (input.items.some(item => !Number.isInteger(item.quantity) || item.quantity < 1)) {
    throw new PoolOrderError(ErrorCode.POOL_ORDER_INVALID, '数量必须是正整数')
  }
  if (totalCount > maxInstances) {
    throw new PoolOrderError(ErrorCode.POOL_ORDER_TOO_LARGE, `一次最多购买 ${maxInstances} 台`, { max: maxInstances, requested: totalCount })
  }

  const seenNames = new Set<string>()
  const items: ResolvedItem[] = []
  let totalYuan = 0

  // 同一商品多行按 poolPriceId 排序，预占时加锁顺序才一致。
  const sortedInputs = [...input.items].sort((left, right) => left.poolPriceId - right.poolPriceId)

  for (const item of sortedInputs) {
    const product = await resolvePoolProduct(item.poolPriceId)
    if (!product) throw new PoolOrderError(ErrorCode.PACKAGE_UNAVAILABLE, `商品 #${item.poolPriceId} 不存在或已下架`, { poolPriceId: item.poolPriceId })

    const [pkg, plan] = await Promise.all([db.getPackageById(product.packageId), getPlanById(product.planId)])
    if (!pkg || !pkg.active || !plan || !plan.isActive) {
      throw new PoolOrderError(ErrorCode.PACKAGE_UNAVAILABLE, `商品 #${item.poolPriceId} 不可购买`, { poolPriceId: item.poolPriceId })
    }

    // 名字：格式校验沿用单台路径，同一单内不得重名。
    const names = buildInstanceNames(item.namePrefix.trim(), item.quantity)
    for (const name of names) {
      const validation = validateName(name, 'Instance name', 2, 64)
      if (!validation.valid) throw new PoolOrderError(ErrorCode.INVALID_NAME, validation.message || '实例名称不合法', { name })
      if (seenNames.has(name)) throw new PoolOrderError(ErrorCode.POOL_ORDER_INVALID, `实例名称重复：${name}`, { name })
      seenNames.add(name)
    }

    // 镜像：必须存在、可见、容器镜像、架构与机型一致、与配额内存兼容。
    const image = await prisma.systemImage.findUnique({ where: { remoteAlias: item.image } })
    if (!image || image.hidden) throw new PoolOrderError(ErrorCode.IMAGE_NOT_FOUND, `镜像不可用：${item.image}`, { poolPriceId: item.poolPriceId })
    if (image.instanceType === 'vm') throw new PoolOrderError(ErrorCode.IMAGE_TYPE_MISMATCH, `镜像 ${item.image} 只支持虚拟机`, { poolPriceId: item.poolPriceId })
    const architecture = architectureOfPreset(product.price.resourcePreset)
    if (image.architecture !== architecture) {
      throw new PoolOrderError(ErrorCode.IMAGE_TYPE_MISMATCH, `镜像 ${item.image} 的架构 ${image.architecture} 与机型 ${product.price.resourcePreset} 不匹配`, { poolPriceId: item.poolPriceId })
    }
    if (!await isImageCompatibleWithMemory(item.image, plan.memory)) {
      throw new PoolOrderError(ErrorCode.IMAGE_MEMORY_INCOMPATIBLE, `镜像 ${item.image} 不适用于该内存配额`, { poolPriceId: item.poolPriceId })
    }

    // 自定义初始化命令：归属与发行版兼容性沿用现有校验。
    let extraShellCommands: string | undefined
    if (item.customInitCommandIds && item.customInitCommandIds.length > 0) {
      const validation = await validateCommandsOwnership(item.customInitCommandIds, userId)
      if (!validation.valid) throw new PoolOrderError(ErrorCode.INVALID_PARAMS, '自定义初始化命令不可用', { poolPriceId: item.poolPriceId })
      const distro = getImageDistroFromAlias(item.image)
      const compatible = validation.commands.filter(cmd => cmd.distros.includes('all') || cmd.distros.includes(distro))
      if (compatible.length > 0) extraShellCommands = mergeCommandContents(compatible)
    }

    const networkMode = (NETWORK_MODES as readonly string[]).includes(pkg.network_mode || '')
      ? (pkg.network_mode as NetworkMode)
      : 'nat'

    const billing = calculateCreateBilling(plan)
    totalYuan = roundMoney(totalYuan + billing.totalPrice * item.quantity)

    const planned: PlannedInstance[] = names.map(name => {
      const rootPassword = generateRandomPassword(16)
      const { configPayload, metaData } = generateIncusConfig({
        instanceName: name,
        imageAlias: item.image,
        rootPassword,
        sshKey,
        networkMode,
        type: 'container',
        extraShellCommands
      })
      return { name, incusId: `u${userId}-${shortId()}`, rootPassword, sshPort: metaData.sshPort, configPayload, extraShellCommands }
    })

    items.push({ input: item, product, pkg, plan, billing, networkMode, planned })
  }

  const totalCents = Math.round(totalYuan * 100)
  if (totalCents !== input.expectedTotal) {
    throw new PoolOrderError(ErrorCode.POOL_PRICE_CHANGED, '价格已变动，请确认新的合计', { expectedTotal: input.expectedTotal, total: totalCents })
  }

  return { items, totalYuan, totalCount }
}

/**
 * 缺货回包：事务已回滚之后，按分配器同一套就绪判据算出每个商品的可售台数，
 * 让购物车能把数量上限改成真实余量，而不只是知道「有一行不够」。
 */
async function buildShortages(items: ResolvedItem[]): Promise<Array<{ poolPriceId: number; requested: number; available: number }>> {
  const pools = await poolInventory({ readyOnly: true })
  return items
    .map(item => {
      const price = item.product.price
      const stock = pools.find(pool =>
        pool.machineGroupId === price.machineGroupId &&
        pool.resourcePreset === price.resourcePreset &&
        pool.regionGroupId === price.regionGroupId &&
        pool.diskGiB === price.diskGiB)
      return { poolPriceId: price.id, requested: item.input.quantity, available: stock?.idle ?? 0 }
    })
    .filter(entry => entry.available < entry.requested)
}

interface CreatedInstance {
  instanceId: number
  host: NonNullable<Awaited<ReturnType<typeof db.selectAndReserveHostWithLock>>>
  item: ResolvedItem
  planned: PlannedInstance
}

export async function placePoolOrder(userId: number, username: string, input: PoolOrderInput): Promise<PoolOrderResult> {
  const keyRecord = await db.getSSHKeyById(input.sshKeyId)
  if (!keyRecord || keyRecord.user_id !== userId) {
    throw new PoolOrderError(ErrorCode.SSH_KEY_NOT_OWNED, 'SSH 密钥不存在或不属于当前用户')
  }
  const sshKey = keyRecord.public_key

  const { items, totalYuan, totalCount } = await prepareOrder(userId, input, sshKey)
  const batchId = batchIdGen()
  const now = new Date()

  let created: CreatedInstance[]
  try {
    created = await prisma.$transaction(async tx => {
      // 先扣款再预占：预占失败整单回滚时扣款一并撤销；带余额条件的原子更新防止并发下单用旧余额覆盖。
      const walletUpdate = await tx.user.updateMany({
        where: { id: userId, balance: { gte: totalYuan } },
        data: { balance: { decrement: totalYuan } }
      })
      if (walletUpdate.count !== 1) throw new PoolOrderError(ErrorCode.BALANCE_INSUFFICIENT, '余额不足')

      const updatedUser = await tx.user.findUnique({ where: { id: userId }, select: { balance: true } })
      if (!updatedUser) throw new PoolOrderError(ErrorCode.USER_NOT_FOUND, '用户不存在')
      const balanceAfter = Number(updatedUser.balance)
      const balanceLog = await tx.balanceLog.create({
        data: {
          userId,
          type: 'consume',
          amount: -totalYuan,
          balanceBefore: roundMoney(balanceAfter + totalYuan),
          balanceAfter,
          remark: `一机一卖订单 ${batchId}：${totalCount} 台`
        }
      })

      const results: CreatedInstance[] = []
      for (const item of items) {
        const price = item.product.price
        for (let index = 0; index < item.planned.length; index++) {
          const planned = item.planned[index]
          const lockedHost = await db.selectAndReserveHostWithLock(tx, {
            cpu: item.plan.cpu,
            memory: item.plan.memory,
            disk: item.plan.disk,
            ownerId: item.pkg.user_id!,
            portCount: 0,
            poolMachineGroupId: price.machineGroupId,
            poolRegionGroupId: price.regionGroupId,
            poolResourcePreset: price.resourcePreset,
            poolDiskGiB: price.diskGiB
          })
          if (!lockedHost) {
            throw new PoolOrderError(ErrorCode.POOL_STOCK_SHORT, '库存不足', {
              shortages: [{ poolPriceId: price.id, requested: item.input.quantity, available: index }]
            })
          }

          const monthlyTrafficLimit = await resolveInstanceTrafficLimitForHost(tx as any, {
            packageId: item.pkg.id,
            hostId: lockedHost.id,
            baseTrafficLimit: item.plan.trafficLimit
          })
          const bandwidthLimit = item.plan.trafficLimitSpeed && item.plan.trafficLimitSpeed !== '0'
            ? normalizePlanTrafficLimitSpeed(item.plan.trafficLimitSpeed)
            : null

          const instance = await tx.instance.create({
            data: {
              incusId: planned.incusId,
              name: planned.name,
              userId,
              hostId: lockedHost.id,
              packageId: item.pkg.id,
              packagePlanId: item.plan.id,
              billingMode: 'package',
              image: item.input.image,
              cpu: item.plan.cpu,
              memory: item.plan.memory,
              disk: item.plan.disk,
              networkMode: item.networkMode,
              snapshottedSpecs: {
                packageId: item.pkg.id,
                packageName: item.pkg.name,
                cpuMax: item.pkg.cpu_max,
                memoryMax: item.pkg.memory_max,
                diskMax: item.pkg.disk_max,
                networkMode: item.networkMode,
                portLimit: item.plan.portLimit,
                nested: Boolean(item.pkg.nested),
                privileged: Boolean(item.pkg.privileged),
                sshPublicKey: sshKey,
                nodeSelectors: [],
                billingMode: 'package',
                packagePlanId: item.plan.id,
                poolPriceId: price.id,
                purchaseBatchId: batchId,
                createdAt: now.toISOString()
              } as Prisma.InputJsonValue,
              sshPort: planned.sshPort,
              rootPassword: encryptSensitiveData(planned.rootPassword),
              status: 'creating',
              monthlyTrafficLimit,
              portLimit: item.plan.portLimit,
              snapshotLimit: item.plan.snapshotLimit,
              backupLimit: item.plan.backupLimit,
              siteLimit: item.plan.siteLimit,
              swapEnabled: false,
              swapSize: item.plan.swapSize,
              limitsIngress: bandwidthLimit,
              limitsEgress: bandwidthLimit,
              expiresAt: item.billing.expiresAt,
              billingPrice: item.billing.price,
              billingCycle: item.billing.billingCycle,
              poolPriceId: price.id,
              purchaseBatchId: batchId,
              trafficBillingMode: 'package',
              trafficUnitPrice: 0,
              nextTrafficBillingAt: null,
              autoRenew: false
            }
          })

          await tx.instanceBillingRecord.create({
            data: {
              instanceId: instance.id,
              userId,
              type: 'newPurchase',
              amount: item.billing.totalPrice,
              months: item.billing.billingCycle,
              periodStart: now,
              periodEnd: item.billing.expiresAt,
              balanceLogId: balanceLog.id,
              purchaseBatchId: batchId,
              remark: item.billing.setupFee > 0
                ? `新开通 ${item.billing.billingCycle} 个月，含初装费 ¥${item.billing.setupFee.toFixed(2)}（订单 ${batchId}）`
                : `新开通 ${item.billing.billingCycle} 个月（订单 ${batchId}）`
            }
          })

          await db.processHostingIncome(lockedHost.id, item.billing.totalPrice, instance.id, 'purchase', tx)
          results.push({ instanceId: instance.id, host: lockedHost, item, planned })
        }
      }
      return results
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 120000
    })
  } catch (error) {
    if (error instanceof PoolOrderError && error.code === ErrorCode.POOL_STOCK_SHORT) {
      const shortages = await buildShortages(items).catch(() => null)
      if (shortages && shortages.length > 0) {
        throw new PoolOrderError(error.code, error.message, { shortages })
      }
    }
    throw error
  }

  // 事务之后逐台完成 IP 预留、cloud-init、存储池并入队开通。
  // 任何一台在这里失败都只影响它自己：实例停在 creating，由 10 分钟超时任务按单台结算退款。
  for (const entry of created) {
    try {
      await startProvisioning(userId, sshKey, entry)
    } catch (error) {
      console.error(`[PoolOrder] 实例 ${entry.instanceId} 开通准备失败，交由超时任务处理:`, error)
    }
  }

  await createLog(
    userId,
    'instance',
    'instance.pool_order',
    `Pool order ${batchId}: ${totalCount} instance(s), ¥${totalYuan.toFixed(2)} by ${username}`,
    'success'
  )

  if (created.length > 1) {
    sendNotification(userId, 'pool_order_submitted', { batchId, totalCount: created.length, orderAmount: totalYuan })
      .catch(error => console.error('[PoolOrder] 发送受理通知失败:', error))
  }

  return {
    batchId,
    total: Math.round(totalYuan * 100),
    instances: created.map(entry => ({
      id: entry.instanceId,
      name: entry.planned.name,
      incusId: entry.planned.incusId,
      host: entry.host.name,
      status: 'creating' as const,
      sshPort: entry.planned.sshPort,
      rootPassword: entry.planned.rootPassword
    }))
  }
}

/** 与单台路径的「阶段六」一致：IP 预留 → 带静态地址重生成 cloud-init → 存储池 → 异步开通。 */
async function startProvisioning(userId: number, sshKey: string, entry: CreatedInstance): Promise<void> {
  const { instanceId, host, item, planned } = entry
  const hostWithIpv6 = host as typeof host & {
    ipv6_subnet?: string | null
    ipv6_gateway?: string | null
    ipv6_parent_interface?: string | null
  }
  const needsRoutedIPv6 = ['nat_ipv6', 'ipv6_only'].includes(item.networkMode)
  const reserved = await db.reserveInstanceIpAddresses({
    instanceId,
    hostId: host.id,
    allocateIpv4: item.networkMode !== 'ipv6_only',
    ipv6Subnet: needsRoutedIPv6 ? hostWithIpv6.ipv6_subnet ?? null : null
  })

  // 与单台路径一致：拿到静态地址后重新生成带 network-config 的 cloud-init
  let configPayload = planned.configPayload
  if (reserved.ipv4 || reserved.ipv6) {
    const regenerated = generateIncusConfig({
      instanceName: planned.name,
      imageAlias: item.input.image,
      rootPassword: planned.rootPassword,
      sshKey,
      networkMode: item.networkMode,
      type: 'container',
      network: {
        ipAddress: reserved.ipv4 ? `${reserved.ipv4}/22` : undefined,
        gateway: reserved.ipv4 ? '10.10.0.1' : undefined,
        dns: reserved.ipv4 ? ['10.10.0.1'] : undefined,
        ipv6Address: reserved.ipv6 ? `${reserved.ipv6}/128` : undefined,
        ipv6Gateway: reserved.ipv6 ? 'fe80::1' : undefined
      },
      extraShellCommands: planned.extraShellCommands
    })
    configPayload = regenerated.configPayload
  }

  const storagePool = (await db.resolveStoragePoolForNewInstance(host.id, { packageId: item.pkg.id })) || 'default'
  await prisma.instance.update({ where: { id: instanceId }, data: { storagePoolName: storagePool } })

  void createInstanceAsync(instanceId, host, {
    name: planned.incusId,
    image: item.input.image,
    cpu: item.plan.cpu,
    memory: item.plan.memory,
    disk: item.plan.disk,
    swapEnabled: false,
    swapSize: item.plan.swapSize,
    cloudInitConfig: configPayload,
    networkMode: item.networkMode,
    nested: Boolean(item.pkg.nested),
    privileged: Boolean(item.pkg.privileged),
    portLimit: item.plan.portLimit,
    instanceType: 'container',
    sshPort: planned.sshPort,
    storagePool,
    ipv4Address: reserved.ipv4,
    ipv6Address: reserved.ipv6,
    ipv6Gateway: hostWithIpv6.ipv6_gateway || null,
    hostInterface: hostWithIpv6.ipv6_parent_interface || 'eth0',
    limitsIngress: item.plan.trafficLimitSpeed && item.plan.trafficLimitSpeed !== '0' ? normalizePlanTrafficLimitSpeed(item.plan.trafficLimitSpeed) : null,
    limitsEgress: item.plan.trafficLimitSpeed && item.plan.trafficLimitSpeed !== '0' ? normalizePlanTrafficLimitSpeed(item.plan.trafficLimitSpeed) : null
  }, userId, {
    cpu: item.plan.cpu,
    memory: item.plan.memory,
    disk: item.plan.disk,
    portCount: 0
  }).catch(error => {
    console.error(`[PoolOrder] 实例 ${instanceId} 开通失败:`, error instanceof Error ? error.message : error)
  })
}
