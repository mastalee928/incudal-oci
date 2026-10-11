<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useToast } from '@/stores/toast'
import { groupByContinent, type ContinentCode } from '@/utils/countryContinent'
import type { HostMachineGroup, HostPoolInventoryRow, HostPoolPrice, HostPoolPriceInput, ResourcePreset } from '@/types/api'

const { t, te } = useI18n()
const toast = useToast()

const PRESETS: ResourcePreset[] = ['E2', 'ARM1C', 'ARM2C', 'ARM3C', 'ARM4C']
/** 预设 → 机型分组名。E2 归 E2 组，ARM 各核心归 ARM 组。 */
const presetGroupName = (preset: ResourcePreset) => (preset === 'E2' ? 'E2' : 'ARM')

const groups = ref<HostMachineGroup[]>([])
const inventory = ref<HostPoolInventoryRow[]>([])
const saved = ref<HostPoolPrice[]>([])
const loading = ref(true)
const loadFailed = ref(false)
const saving = ref(false)
const resourcePreset = ref<ResourcePreset>('E2')
const priceView = ref<'monthly' | 'setup'>('monthly')

// 编辑缓冲：`${regionGroupId}:${diskGiB}` → 元的字符串。留空 = 该格不卖。
const monthly = ref<Record<string, string>>({})
const setup = ref<Record<string, string>>({})

const cellKey = (regionGroupId: number, diskGiB: number) => `${regionGroupId}:${diskGiB}`

const machineGroup = computed(() => groups.value.find(group => group.name === presetGroupName(resourcePreset.value)) || null)
const regions = computed(() => machineGroup.value?.regions || [])

/** 该机型实际存在的磁盘档，来自库存。没有机器的档位不出现，避免大片空格。 */
const diskTiers = computed(() => {
  const tiers = new Set<number>()
  for (const pool of inventory.value) {
    if (pool.machineGroupId !== machineGroup.value?.id || pool.resourcePreset !== resourcePreset.value) continue
    if (pool.diskGiB !== null) tiers.add(pool.diskGiB)
  }
  return [...tiers].sort((a, b) => a - b)
})

const rowsByContinent = computed(() => groupByContinent(regions.value.map(region => ({ ...region, countryCode: region.countryCode }))))

function stockOf(regionGroupId: number, diskGiB: number): HostPoolInventoryRow | null {
  return inventory.value.find(pool =>
    pool.machineGroupId === machineGroup.value?.id &&
    pool.resourcePreset === resourcePreset.value &&
    pool.regionGroupId === regionGroupId &&
    pool.diskGiB === diskGiB) || null
}

/** 已有定价，供保存时比对；未上架的行也读进来，否则「下架」会被当成「没填过」。 */
function priceOf(regionGroupId: number, diskGiB: number): HostPoolPrice | null {
  return saved.value.find(row => row.regionGroupId === regionGroupId && row.diskGiB === diskGiB) || null
}

/** 分 → 元，用于填进输入框。 */
const centsToYuan = (cents: number) => (cents ? String(cents / 100) : '')
/** 元 → 分。空串返回 null（= 不卖）。 */
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
  for (const row of saved.value) {
    const key = cellKey(row.regionGroupId, row.diskGiB)
    nextMonthly[key] = centsToYuan(row.monthlyPrice)
    nextSetup[key] = centsToYuan(row.setupFee)
  }
  monthly.value = nextMonthly
  setup.value = nextSetup
}

async function load() {
  loading.value = true
  try {
    const [groupsResult, inventoryResult, pricesResult] = await Promise.all([
      api.hostOnboarding.groups(),
      api.hostPools.inventory(),
      api.hostPools.prices({ resourcePreset: resourcePreset.value })
    ])
    groups.value = groupsResult.groups
    inventory.value = inventoryResult.pools
    saved.value = pricesResult.prices
    resetBuffers()
    loadFailed.value = false
  } catch { loadFailed.value = true } finally { loading.value = false }
}

async function switchPreset() {
  const pricesResult = await api.hostPools.prices({ resourcePreset: resourcePreset.value })
  saved.value = pricesResult.prices
  resetBuffers()
}

async function save() {
  if (saving.value || !machineGroup.value) return
  const items: HostPoolPriceInput[] = []
  const removals: number[] = []
  let invalid = false

  for (const region of regions.value) {
    for (const diskGiB of diskTiers.value) {
      const key = cellKey(region.id, diskGiB)
      const existing = priceOf(region.id, diskGiB)
      const monthlyCents = yuanToCents(monthly.value[key] ?? '')
      const setupCents = yuanToCents(setup.value[key] ?? '')

      if (monthlyCents === null) {
        // 留空 = 不卖：已经存在过就删掉，从没填过就跳过
        if (existing) removals.push(existing.id)
        continue
      }
      if ((monthly.value[key] ?? '').trim() && monthlyCents === null) invalid = true
      if (setupCents === null && (setup.value[key] ?? '').trim()) invalid = true

      const setupValue = setupCents ?? 0
      if (existing && existing.monthlyPrice === monthlyCents && existing.setupFee === setupValue) continue
      items.push({
        machineGroupId: machineGroup.value.id,
        resourcePreset: resourcePreset.value,
        regionGroupId: region.id,
        diskGiB,
        name: existing?.name ?? null,
        monthlyPrice: monthlyCents,
        setupFee: setupValue,
        active: true
      })
    }
  }

  if (invalid) { toast.error(t('hostPools.invalidPrice')); return }
  if (!items.length && !removals.length) { toast.success(t('hostPools.nothingChanged')); return }

  saving.value = true
  try {
    if (items.length) await api.hostPools.savePrices(items)
    for (const id of removals) await api.hostPools.deletePrice(id)
    toast.success(t('hostPools.saved'))
    const pricesResult = await api.hostPools.prices({ resourcePreset: resourcePreset.value })
    saved.value = pricesResult.prices
    resetBuffers()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    toast.error(te(`onboarding.errors.${code}`) ? t(`onboarding.errors.${code}`) : t('hostPools.saveFailed'))
  } finally { saving.value = false }
}

function continentLabel(code: ContinentCode) { return t(`hostPools.continent.${code}`) }

onMounted(() => void load())
</script>

<template>
  <div class="space-y-4 animate-fade-in">
    <div class="page-header gap-3">
      <div class="min-w-0">
        <h1 class="page-title">{{ t('hostPools.title') }}</h1>
        <p class="page-description">{{ t('hostPools.description') }}</p>
      </div>
      <button type="button" class="btn-primary whitespace-nowrap" :disabled="saving || loading || !machineGroup" @click="save">
        {{ t(saving ? 'hostPools.saving' : 'hostPools.save') }}
      </button>
    </div>

    <section class="card p-4 flex flex-wrap items-end gap-3">
      <label class="text-sm text-themed min-w-0">
        {{ t('hostPools.core') }}
        <select v-model="resourcePreset" class="input w-full mt-1 min-w-40" @change="switchPreset">
          <option v-for="preset in PRESETS" :key="preset" :value="preset">{{ preset }}</option>
        </select>
      </label>
      <label class="text-sm text-themed min-w-0">
        {{ t('hostPools.priceView') }}
        <select v-model="priceView" class="input w-full mt-1 min-w-40">
          <option value="monthly">{{ t('hostPools.monthlyPrice') }}</option>
          <option value="setup">{{ t('hostPools.setupFee') }}</option>
        </select>
      </label>
      <p class="text-xs text-themed-muted ml-auto">{{ t('hostPools.emptyHint') }}</p>
    </section>

    <div v-if="loadFailed" class="card p-4 text-sm text-red-600 dark:text-red-400" role="alert">{{ t('hostPools.loadFailed') }}</div>
    <div v-else-if="loading" class="card p-8 text-sm text-themed-muted text-center">{{ t('common.loading') }}</div>
    <div v-else-if="!machineGroup" class="card p-8 text-center text-sm text-themed-muted">{{ t('hostPools.noMachineGroup') }}</div>
    <div v-else-if="!diskTiers.length" class="card p-8 text-center text-sm text-themed-muted">{{ t('hostPools.noMachines') }}</div>

    <section v-for="continent in rowsByContinent" v-else :key="continent.code" class="card overflow-hidden">
      <h2 class="px-4 py-2 text-sm font-medium text-themed bg-themed-secondary">{{ continentLabel(continent.code) }}</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-themed">
              <th class="px-4 py-2 text-left font-medium text-themed-muted">{{ t('hostPools.region') }}</th>
              <th v-for="diskGiB in diskTiers" :key="diskGiB" class="px-3 py-2 text-left font-medium text-themed-muted whitespace-nowrap">
                {{ diskGiB }} GiB
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="region in continent.items" :key="region.id" class="border-b border-themed last:border-b-0">
              <td class="px-4 py-2 text-themed break-words min-w-40">{{ region.name }}</td>
              <td v-for="diskGiB in diskTiers" :key="diskGiB" class="px-3 py-2 align-top">
                <input
                  v-if="priceView === 'monthly'"
                  v-model="monthly[cellKey(region.id, diskGiB)]"
                  type="number" min="0" step="0.01" inputmode="decimal"
                  class="input w-28"
                  :placeholder="t('hostPools.notSold')"
                  :aria-label="`${region.name} ${diskGiB} GiB ${t('hostPools.monthlyPrice')}`"
                />
                <input
                  v-else
                  v-model="setup[cellKey(region.id, diskGiB)]"
                  type="number" min="0" step="0.01" inputmode="decimal"
                  class="input w-28"
                  :placeholder="t('hostPools.freeSetup')"
                  :aria-label="`${region.name} ${diskGiB} GiB ${t('hostPools.setupFee')}`"
                />
                <p class="mt-1 text-xs text-themed-muted whitespace-nowrap">
                  <template v-if="stockOf(region.id, diskGiB)">
                    {{ t('hostPools.stock', { idle: stockOf(region.id, diskGiB)!.idle, total: stockOf(region.id, diskGiB)!.total }) }}
                  </template>
                  <template v-else>{{ t('hostPools.noStock') }}</template>
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
