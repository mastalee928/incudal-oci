export type PackageSource = 'official' | 'market' | `zone:${number}`
export type PackageSourceRequest = {
  source: 'official' | 'market' | 'zone'
  zoneId?: number
}

export interface PublicPackagePlan {
  id: number
  name: string
  description: string | null
  cpu: number
  memory: number
  disk: number
  portLimit: number
  snapshotLimit: number
  backupLimit: number
  siteLimit: number
  swapSize: number
  trafficLimit: string
  trafficLimitSpeed: string
  trafficBillingMode: 'package' | 'usage'
  trafficUnitPrice: number
  billingMode: 'package' | 'hourly'
  price: number
  billingCycle: number
  setupFee: number
  slaGuarantee: number | null
  isSoldOut: boolean
  monthlyPrice: number
}

export interface PublicPackage {
  id: number
  name: string
  description: string | null
  cpu_max: number
  memory_max: number
  disk_max: number
  monthly_traffic_limit: string | null
  network_mode: string
  instance_type: string
  host_ids: number[]
  privileged: number
  nested: number
  sourceType: 'official' | 'market'
  soldOut: boolean
  isPaid: boolean
  plans: PublicPackagePlan[]
}

export interface PublicRegion {
  code: string
  name: string
  packageIds: number[]
  hostCount: number
}

function getQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined
  }
  return typeof value === 'string' ? value : undefined
}

export function normalizePackageSourceQuery(value: unknown, zoneIdValue?: unknown): PackageSource {
  const query = getQueryString(value)
  if (query === 'market') return 'market'
  if (query === 'zone') {
    const zoneId = parsePackageIdQuery(zoneIdValue)
    return zoneId ? `zone:${zoneId}` : 'official'
  }
  if (query?.startsWith('zone:')) {
    const zoneId = Number(query.slice('zone:'.length))
    return Number.isInteger(zoneId) && zoneId > 0 ? `zone:${zoneId}` : 'official'
  }
  return 'official'
}

export function toPackageSourceRequest(source: PackageSource): PackageSourceRequest {
  if (source.startsWith('zone:')) {
    const zoneId = Number(source.slice('zone:'.length))
    return { source: 'zone', zoneId }
  }
  return { source: source === 'market' ? 'market' : 'official' }
}

export function parsePackageIdQuery(value: unknown): number | null {
  const query = getQueryString(value)
  if (!query) {
    return null
  }

  const parsed = Number(query)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function parseTextQuery(value: unknown): string {
  return getQueryString(value)?.trim() || ''
}

export function formatPublicTraffic(bytes: string | null, unlimitedLabel: string): string {
  if (!bytes || bytes === '0') {
    return unlimitedLabel
  }

  const value = BigInt(bytes)
  const tb = BigInt(1024 * 1024 * 1024 * 1024)
  const gb = BigInt(1024 * 1024 * 1024)

  if (value >= tb) {
    return `${(Number(value) / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`
  }

  if (value >= gb) {
    return `${(Number(value) / (1024 * 1024 * 1024)).toFixed(0)} GB`
  }

  return `${(Number(value) / (1024 * 1024)).toFixed(0)} MB`
}

export function getPackageTrafficLabel(
  pkg: Pick<PublicPackage, 'plans' | 'monthly_traffic_limit'>,
  unlimitedLabel: string
): string {
  const availablePlans = pkg.plans.filter(plan => !plan.isSoldOut)
  const plans = availablePlans.length > 0 ? availablePlans : pkg.plans

  if (plans.length === 0) {
    return formatPublicTraffic(pkg.monthly_traffic_limit, unlimitedLabel)
  }

  const limits = [...new Set(plans.map(plan => plan.trafficLimit || '0'))]
    .sort((left, right) => {
      const leftValue = left === '0' ? null : BigInt(left)
      const rightValue = right === '0' ? null : BigInt(right)
      if (leftValue === null) return rightValue === null ? 0 : 1
      if (rightValue === null) return -1
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    })

  const minimum = formatPublicTraffic(limits[0], unlimitedLabel)
  const maximum = formatPublicTraffic(limits[limits.length - 1], unlimitedLabel)
  return minimum === maximum ? minimum : `${minimum} – ${maximum}`
}

export function formatPublicPrice(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function getStartingMonthlyPrice(pkg: Pick<PublicPackage, 'isPaid' | 'plans'>): number | null {
  if (!pkg.isPaid || pkg.plans.length === 0) {
    return null
  }

  const packagePlans = pkg.plans.filter(plan => plan.billingMode !== 'hourly')
  if (packagePlans.length === 0) {
    return null
  }

  const availablePlans = packagePlans.filter(plan => !plan.isSoldOut)
  const pricePlans = availablePlans.length > 0 ? availablePlans : packagePlans

  return pricePlans.reduce((minPrice, plan) => {
    if (plan.monthlyPrice < minPrice) {
      return plan.monthlyPrice
    }
    return minPrice
  }, pricePlans[0].monthlyPrice)
}

// ==================== 一机一卖：池子商品目录 ====================
// 池子 = 机型分组 + 核心数 + 地区 + 磁盘档；一行 = 一个可售商品，没有行 = 不卖。
// 价格单位是「分」，与后端一致；展示前用 formatPublicPrice 转成元。

export interface PoolCatalogProduct {
  id: number
  resourcePreset: string
  diskGiB: number
  monthlyPrice: number
  setupFee: number
  cpu: number
  memoryMiB: number
  /** 空闲台数（与分配器同一套就绪判据）。0 = 该档位无货，界面灰掉但保留展示。 */
  idle: number
  total: number
}

export interface PoolCatalogRegion {
  id: number
  name: string
  countryCode: string | null
  products: PoolCatalogProduct[]
}

/**
 * 池子的系统架构。
 * 客户不能指定机器，所以镜像必须由机型决定：E2 是 x86，ARM 各核心是 aarch64。
 */
export function architectureOfPreset(preset: string): 'x86_64' | 'aarch64' {
  return preset.startsWith('ARM') ? 'aarch64' : 'x86_64'
}

/** 机型展示名：E2 保持原样，ARM 显示核心数（ARM2C → ARM 2C）。 */
export function presetLabel(preset: string): string {
  const matched = /^ARM(\d)C$/.exec(preset)
  return matched ? `ARM ${matched[1]}C` : preset
}

/** 机型族：E2 与 ARM 是两级选择（选 ARM 再分核心数）。 */
export function presetFamily(preset: string): 'E2' | 'ARM' {
  return preset.startsWith('ARM') ? 'ARM' : 'E2'
}

/** ARM 的核心数（ARM2C → 2）；E2 返回 null。 */
export function presetCores(preset: string): number | null {
  const matched = /^ARM(\d)C$/.exec(preset)
  return matched ? Number(matched[1]) : null
}

/** 由族与核心数还原预设串：E2 → 'E2'，ARM + 2 → 'ARM2C'。 */
export function presetOf(family: 'E2' | 'ARM', cores: number | null): string {
  return family === 'E2' ? 'E2' : `ARM${cores ?? 1}C`
}

/** 内存展示：MiB → GiB（整数或一位小数）。 */
export function formatMemoryMiB(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GiB`
  return `${mib} MiB`
}

/** 多台时的实例名：一台就是前缀本身，多台「前缀-01」起编号。与服务端生成规则一致。 */
export function buildPoolInstanceNames(prefix: string, quantity: number): string[] {
  const count = Math.max(1, Math.floor(quantity))
  if (count === 1) return [prefix]
  const width = Math.max(2, String(count).length)
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(width, '0')}`)
}
