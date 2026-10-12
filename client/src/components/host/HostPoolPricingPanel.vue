<script setup lang="ts">
/**
 * 池子定价（扁平表）
 *
 * 行 = 你实际有的池子（由机器自动汇总：机型/核心 + 地区 + 磁盘档），有什么机器就定什么价；
 * 没有机器的池子不出现，也不靠分组名字查找。顶部横幅列出「没设规格」的机器，就地补规格。
 * 价格单位：输入框是元，接口是分。留空 = 不卖。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import FlagIcon from '@/components/FlagIcon.vue'
import { useToast } from '@/stores/toast'
import { presetLabel } from '@/utils/publicCatalog'
import type { HostMachineGroup, HostPoolInventoryRow, HostPoolPrice, HostPoolPriceInput, HostPoolUnspecifiedHost, ResourcePreset } from '@/types/api'

const { t, te } = useI18n()
const toast = useToast()

const PRESETS: ResourcePreset[] = ['E2', 'ARM1C', 'ARM2C', 'ARM3C', 'ARM4C']
const DISK_TIERS = [30, 60, 90, 120]
const presetRank = (preset: string) => { const index = PRESETS.indexOf(preset as ResourcePreset); return index === -1 ? PRESETS.length : index }
const architectureOf = (preset: string) => (preset.startsWith('ARM') ? 'aarch64' : 'x86_64')

const groups = ref<HostMachineGroup[]>([])
const pools = ref<HostPoolInventoryRow[]>([])
const unspecified = ref<HostPoolUnspecifiedHost[]>([])
const prices = ref<HostPoolPrice[]>([])
const loading = ref(true)
const loadFailed = ref(false)
const saving = ref(false)

// 编辑缓冲：按池子键存元的字符串与上架开关。留空 = 不卖。
const monthly = ref<Record<string, string>>({})
const setup = ref<Record<string, string>>({})
const active = ref<Record<string, boolean>>({})

// 补规格表单
const specPreset = ref<ResourcePreset>('E2')
const specDisk = ref<number>(30)
const specSelected = ref<number[]>([])
const specSaving = ref(false)

interface PoolRow {
  key: string
  machineGroupId: number
  machineName: string
  resourcePreset: string
  regionGroupId: number
  regionName: string
  countryCode: string | null
  diskGiB: number
  total: number
  idle: number
  price: HostPoolPrice | null
}

const poolKey = (machineGroupId: number, preset: string, regionGroupId: number, diskGiB: number) => `${machineGroupId}:${preset}:${regionGroupId}:${diskGiB}`

const regionIndex = computed(() => {
  const index = new Map<number, { name: string; countryCode: string | null; machineName: string }>()
  for (const group of groups.value) for (const region of group.regions) index.set(region.id, { name: region.name, countryCode: region.countryCode, machineName: group.name })
  return index
})

/** 真实池子 + 已经没有机器但仍有价格行的孤儿池子（标成 0 台，让你能看见并清掉）。 */
const rows = computed<PoolRow[]>(() => {
  const byKey = new Map<string, PoolRow>()
  for (const pool of pools.value) {
    if (!pool.resourcePreset || pool.regionGroupId === null || pool.diskGiB === null || pool.machineGroupId === 0) continue
    const region = regionIndex.value.get(pool.regionGroupId)
    const key = poolKey(pool.machineGroupId, pool.resourcePreset, pool.regionGroupId, pool.diskGiB)
    byKey.set(key, {
      key, machineGroupId: pool.machineGroupId, machineName: region?.machineName || '', resourcePreset: pool.resourcePreset,
      regionGroupId: pool.regionGroupId, regionName: region?.name || `#${pool.regionGroupId}`, countryCode: region?.countryCode ?? null,
      diskGiB: pool.diskGiB, total: pool.total, idle: pool.idle, price: null
    })
  }
  for (const price of prices.value) {
    const key = poolKey(price.machineGroupId, price.resourcePreset, price.regionGroupId, price.diskGiB)
    const existing = byKey.get(key)
    if (existing) { existing.price = price; continue }
    const region = regionIndex.value.get(price.regionGroupId)
    byKey.set(key, {
      key, machineGroupId: price.machineGroupId, machineName: price.machineGroup?.name || region?.machineName || '', resourcePreset: price.resourcePreset,
      regionGroupId: price.regionGroupId, regionName: price.regionGroup?.name || region?.name || `#${price.regionGroupId}`,
      countryCode: price.regionGroup?.countryCode ?? region?.countryCode ?? null, diskGiB: price.diskGiB, total: 0, idle: 0, price
    })
  }
  return [...byKey.values()].sort((a, b) =>
    a.machineName.localeCompare(b.machineName) || presetRank(a.resourcePreset) - presetRank(b.resourcePreset) ||
    a.regionName.localeCompare(b.regionName, 'zh') || a.diskGiB - b.diskGiB)
})

/** 只能给架构相符的机器设这个预设 */
const specEligible = computed(() => unspecified.value.filter(host => host.architecture === architectureOf(specPreset.value)))
const specAllSelected = computed({
  get: () => specEligible.value.length > 0 && specEligible.value.every(host => specSelected.value.includes(host.id)),
  set: (value: boolean) => { specSelected.value = value ? specEligible.value.map(host => host.id) : [] }
})

const centsToYuan = (cents: number) => (cents ? String(cents / 100) : '')
function yuanToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const yuan = Number(trimmed)
  if (!Number.isFinite(yuan) || yuan < 0 || yuan > 99999999) return null
  return Math.round(yuan * 100)
}

function resetBuffers() {
  const nextMonthly: Record<string, string> = {}
  const nextSetup: Record<string, string> = {}
  const nextActive: Record<string, boolean> = {}
  for (const row of rows.value) {
    nextMonthly[row.key] = row.price ? centsToYuan(row.price.monthlyPrice) : ''
    nextSetup[row.key] = row.price ? centsToYuan(row.price.setupFee) : ''
    nextActive[row.key] = row.price ? row.price.active : true
  }
  monthly.value = nextMonthly
  setup.value = nextSetup
  active.value = nextActive
}

async function load() {
  loading.value = true
  try {
    const [groupsResult, inventoryResult, pricesResult] = await Promise.all([
      api.hostOnboarding.groups(), api.hostPools.inventory(), api.hostPools.prices()
    ])
    groups.value = groupsResult.groups
    pools.value = inventoryResult.pools
    unspecified.value = inventoryResult.unspecified
    prices.value = pricesResult.prices
    resetBuffers()
    // 默认按第一台未设规格机器的架构给预设，并全选同架构的机器
    const first = unspecified.value[0]
    if (first) specPreset.value = first.architecture === 'aarch64' ? 'ARM1C' : 'E2'
    specSelected.value = specEligible.value.map(host => host.id)
    loadFailed.value = false
  } catch { loadFailed.value = true } finally { loading.value = false }
}

function onPresetChange() { specSelected.value = specEligible.value.map(host => host.id) }

function errorText(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return te(`onboarding.errors.${code}`) ? t(`onboarding.errors.${code}`) : fallback
}

async function applySpec() {
  if (specSaving.value || specSelected.value.length === 0) return
  specSaving.value = true
  try {
    await api.hostOnboarding.updateSpec({ hostIds: specSelected.value, resourcePreset: specPreset.value, customerDiskGiB: specDisk.value })
    toast.success(t('hostPools.specSaved'))
    await load()
  } catch (error) { toast.error(errorText(error, t('hostPools.specFailed'))) }
  finally { specSaving.value = false }
}

async function save() {
  if (saving.value) return
  const items: HostPoolPriceInput[] = []
  const removals: number[] = []
  for (const row of rows.value) {
    const monthlyText = (monthly.value[row.key] ?? '').trim()
    const setupText = (setup.value[row.key] ?? '').trim()
    const monthlyCents = yuanToCents(monthlyText)
    const setupCents = yuanToCents(setupText)
    if (monthlyText && monthlyCents === null) { toast.error(t('hostPools.invalidPrice')); return }
    if (setupText && setupCents === null) { toast.error(t('hostPools.invalidPrice')); return }
    if (monthlyCents === null) {
      if (row.price) removals.push(row.price.id)
      continue
    }
    const setupValue = setupCents ?? 0
    const isActive = active.value[row.key] ?? true
    if (row.price && row.price.monthlyPrice === monthlyCents && row.price.setupFee === setupValue && row.price.active === isActive) continue
    items.push({
      machineGroupId: row.machineGroupId, resourcePreset: row.resourcePreset as ResourcePreset, regionGroupId: row.regionGroupId, diskGiB: row.diskGiB,
      name: row.price?.name ?? null, monthlyPrice: monthlyCents, setupFee: setupValue, active: isActive
    })
  }
  if (!items.length && !removals.length) { toast.success(t('hostPools.nothingChanged')); return }
  saving.value = true
  try {
    if (items.length) await api.hostPools.savePrices(items)
    for (const id of removals) await api.hostPools.deletePrice(id)
    toast.success(t('hostPools.saved'))
    await load()
  } catch (error) { toast.error(errorText(error, t('hostPools.saveFailed'))) }
  finally { saving.value = false }
}

onMounted(() => void load())
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="text-sm text-themed-muted max-w-2xl">{{ t('hostPools.flatDescription') }}</p>
      <button type="button" class="btn-primary whitespace-nowrap" :disabled="saving || loading || !rows.length" @click="save">
        {{ t(saving ? 'hostPools.saving' : 'hostPools.save') }}
      </button>
    </div>

    <div v-if="loadFailed" class="card p-4 text-sm text-red-600 dark:text-red-400" role="alert">{{ t('hostPools.loadFailed') }}</div>
    <div v-else-if="loading" class="card p-8 text-sm text-themed-muted text-center">{{ t('common.loading') }}</div>

    <template v-else>
      <!-- 没设规格的机器：不属于任何池子，定不了价，就地补 -->
      <section v-if="unspecified.length" class="card p-4 space-y-3 border border-amber-300 dark:border-amber-500/40">
        <p class="text-sm font-medium text-amber-700 dark:text-amber-300">{{ t('hostPools.unspecifiedBanner', { count: unspecified.length }) }}</p>
        <p class="text-xs text-themed-muted">{{ t('hostPools.unspecifiedHint') }}</p>
        <div class="flex flex-wrap items-end gap-3">
          <label class="text-sm text-themed">
            {{ t('hostPools.specPreset') }}
            <select v-model="specPreset" class="input w-full mt-1 min-w-36" @change="onPresetChange">
              <option v-for="preset in PRESETS" :key="preset" :value="preset">{{ presetLabel(preset) }}</option>
            </select>
          </label>
          <label class="text-sm text-themed">
            {{ t('hostPools.specDisk') }}
            <select v-model.number="specDisk" class="input w-full mt-1 min-w-28">
              <option v-for="tier in DISK_TIERS" :key="tier" :value="tier">{{ tier }} GiB</option>
            </select>
          </label>
          <label class="flex items-center gap-2 text-sm text-themed pb-2">
            <input v-model="specAllSelected" type="checkbox" :disabled="!specEligible.length" />{{ t('hostPools.selectAll') }}
          </label>
          <button type="button" class="btn-primary whitespace-nowrap" :disabled="specSaving || !specSelected.length" @click="applySpec">
            {{ t(specSaving ? 'hostPools.applying' : 'hostPools.applySpec', { count: specSelected.length }) }}
          </button>
        </div>
        <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 text-sm">
          <li v-for="host in unspecified" :key="host.id" class="flex items-center gap-2 rounded px-2 py-1.5 bg-themed-secondary" :class="host.architecture !== architectureOf(specPreset) ? 'opacity-60' : ''">
            <input v-model="specSelected" type="checkbox" :value="host.id" :disabled="host.architecture !== architectureOf(specPreset)" :aria-label="host.name" />
            <span class="min-w-0 flex-1 truncate text-themed">{{ host.name }}</span>
            <span class="text-xs text-themed-muted whitespace-nowrap">{{ host.architecture }} · {{ host.machineGroup || t('hostInventory.machineUnset') }} / {{ host.regionGroup || t('hostInventory.regionUnset') }}</span>
            <span v-if="host.architecture !== architectureOf(specPreset)" class="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">{{ t('hostPools.archMismatch') }}</span>
          </li>
        </ul>
      </section>

      <div v-if="!rows.length" class="card p-8 text-center text-sm text-themed-muted">{{ t('hostPools.poolsEmpty') }}</div>

      <section v-else class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-themed">
                <th class="px-4 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colMachine') }}</th>
                <th class="px-4 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colRegion') }}</th>
                <th class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colDisk') }}</th>
                <th class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colStock') }}</th>
                <th class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colMonthly') }}</th>
                <th class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colSetup') }}</th>
                <th class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">{{ t('hostPools.colActive') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key" class="border-b border-themed last:border-b-0" :class="row.total === 0 ? 'opacity-70' : ''">
                <td class="px-4 py-2 text-themed whitespace-nowrap">{{ presetLabel(row.resourcePreset) }}<span v-if="row.machineName" class="text-xs text-themed-muted"> · {{ row.machineName }}</span></td>
                <td class="px-4 py-2 text-themed min-w-40">
                  <span class="flex items-center gap-1.5"><FlagIcon v-if="row.countryCode" :code="row.countryCode" size="xs" /><span class="break-words">{{ row.regionName }}</span></span>
                </td>
                <td class="px-3 py-2 text-themed whitespace-nowrap">{{ row.diskGiB }} GiB</td>
                <td class="px-3 py-2 whitespace-nowrap" :class="row.total === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-themed-muted'">
                  {{ row.total === 0 ? t('hostPools.noHosts') : t('hostPools.stockCell', { idle: row.idle, total: row.total }) }}
                </td>
                <td class="px-3 py-2">
                  <input v-model="monthly[row.key]" type="number" min="0" step="0.01" inputmode="decimal" class="input w-28" :placeholder="t('hostPools.notSold')" :aria-label="`${row.regionName} ${row.diskGiB} GiB ${t('hostPools.monthlyPrice')}`" />
                </td>
                <td class="px-3 py-2">
                  <input v-model="setup[row.key]" type="number" min="0" step="0.01" inputmode="decimal" class="input w-28" :placeholder="t('hostPools.freeSetup')" :aria-label="`${row.regionName} ${row.diskGiB} GiB ${t('hostPools.setupFee')}`" />
                </td>
                <td class="px-3 py-2">
                  <input v-model="active[row.key]" type="checkbox" :disabled="!(monthly[row.key] ?? '').trim()" :aria-label="t('hostPools.colActive')" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="px-4 py-2 text-xs text-themed-muted border-t border-themed">{{ t('hostPools.emptyHint') }}</p>
      </section>
    </template>
  </section>
</template>
