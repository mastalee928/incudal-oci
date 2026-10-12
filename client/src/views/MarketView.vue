<script setup lang="ts">
/**
 * 购买页（一机一卖）
 *
 * 层级：洲 → 地区 → 机型/核心 → 磁盘档。每个池子就是一个商品，唯一变量是价格。
 * 无货的地区/档位照常展示但灰掉不可点；库存与分配器用同一套就绪判据，
 * 所以这里显示有货，下单就一定挑得到机器。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { usePageSeo } from '@/composables/usePageSeo'
import { useBrand } from '@/composables/useBrand'
import FlagIcon from '@/components/FlagIcon.vue'
import PublicSiteLayout from '@/components/public/PublicSiteLayout.vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { groupByContinent, type ContinentCode } from '@/utils/countryContinent'
import {
  formatMemoryMiB,
  formatPublicPrice,
  parsePackageIdQuery,
  presetLabel,
  type PoolCatalogProduct,
  type PoolCatalogRegion
} from '@/utils/publicCatalog'

defineOptions({
  name: 'MarketView'
})

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const brand = useBrand()

/** 机型展示顺序：E2 在前，ARM 按核心数递增。目录里没见过的机型排最后。 */
const PRESET_ORDER = ['E2', 'ARM1C', 'ARM2C', 'ARM3C', 'ARM4C']
function presetRank(preset: string): number {
  const index = PRESET_ORDER.indexOf(preset)
  return index === -1 ? PRESET_ORDER.length : index
}

const regions = ref<PoolCatalogRegion[]>([])
const loading = ref(true)
const loadError = ref('')
const selectedRegionId = ref<number | null>(parsePackageIdQuery(route.query.region))
const selectedPreset = ref<string | null>(typeof route.query.preset === 'string' ? route.query.preset : null)
const selectedProductId = ref<number | null>(parsePackageIdQuery(route.query.product))

const continents = computed(() => groupByContinent(regions.value))
const productCount = computed(() => regions.value.reduce((sum, region) => sum + region.products.length, 0))

function regionIdle(region: PoolCatalogRegion): number {
  return region.products.reduce((sum, product) => sum + product.idle, 0)
}

const selectedRegion = computed<PoolCatalogRegion | null>(() =>
  regions.value.find(region => region.id === selectedRegionId.value) || null)

interface PresetOption {
  preset: string
  idle: number
  cpu: number
  memoryMiB: number
  fromPrice: number
}

/** 当前地区下的机型/核心：同一机型的各磁盘档合并成一个选项，库存相加、价格取最低。 */
const presetOptions = computed<PresetOption[]>(() => {
  const region = selectedRegion.value
  if (!region) return []
  const byPreset = new Map<string, PresetOption>()
  for (const product of region.products) {
    const existing = byPreset.get(product.resourcePreset)
    if (existing) {
      existing.idle += product.idle
      existing.fromPrice = Math.min(existing.fromPrice, product.monthlyPrice)
    } else {
      byPreset.set(product.resourcePreset, {
        preset: product.resourcePreset,
        idle: product.idle,
        cpu: product.cpu,
        memoryMiB: product.memoryMiB,
        fromPrice: product.monthlyPrice
      })
    }
  }
  return [...byPreset.values()].sort((left, right) => presetRank(left.preset) - presetRank(right.preset))
})

const diskOptions = computed<PoolCatalogProduct[]>(() => {
  const region = selectedRegion.value
  if (!region || !selectedPreset.value) return []
  return region.products
    .filter(product => product.resourcePreset === selectedPreset.value)
    .sort((left, right) => left.diskGiB - right.diskGiB)
})

const selectedProduct = computed<PoolCatalogProduct | null>(() =>
  diskOptions.value.find(product => product.id === selectedProductId.value) || null)

const ui = computed(() => themeStore.isDark
  ? {
      body: 'text-gray-400',
      title: 'text-gray-100',
      badge: 'border-gray-800 bg-gray-950 text-gray-300',
      badgeDot: 'bg-white',
      summaryCard: 'border border-gray-800 bg-gray-950',
      summaryLabel: 'text-gray-500',
      summaryValue: 'text-gray-100',
      panel: 'border border-gray-800 bg-gray-950',
      sectionLabel: 'text-gray-500',
      continentLabel: 'text-gray-500',
      optionIdle: 'border border-gray-800 bg-gray-950 text-gray-200 hover:border-gray-600',
      optionActive: 'border border-white bg-white text-gray-900',
      optionDisabled: 'border border-gray-900 bg-gray-950 text-gray-600 cursor-not-allowed',
      muted: 'text-gray-500',
      chipStock: 'border border-emerald-400/40 text-emerald-300',
      chipSoldOut: 'border border-red-400/40 text-red-300',
      errorBanner: 'border border-red-900 bg-red-950 text-red-300',
      skeleton: 'bg-gray-800',
      emptyState: 'border-gray-800 bg-gray-950 text-gray-500',
      cta: 'bg-white text-gray-900 hover:bg-gray-100',
      divider: 'border-gray-800'
    }
  : {
      body: 'text-gray-600',
      title: 'text-gray-900',
      badge: 'border-gray-200 bg-white text-gray-600',
      badgeDot: 'bg-gray-900',
      summaryCard: 'border border-gray-200 bg-white shadow-sm',
      summaryLabel: 'text-gray-500',
      summaryValue: 'text-gray-900',
      panel: 'border border-gray-200 bg-white shadow-sm',
      sectionLabel: 'text-gray-500',
      continentLabel: 'text-gray-500',
      optionIdle: 'border border-gray-200 bg-white text-gray-900 hover:border-gray-400',
      optionActive: 'border border-gray-900 bg-gray-900 text-white',
      optionDisabled: 'border border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed',
      muted: 'text-gray-500',
      chipStock: 'border border-emerald-600/40 text-emerald-700',
      chipSoldOut: 'border border-red-600/40 text-red-700',
      errorBanner: 'border border-red-200 bg-red-50 text-red-700',
      skeleton: 'bg-gray-200',
      emptyState: 'border-gray-300 bg-white text-gray-500',
      cta: 'bg-gray-900 text-white hover:bg-gray-700',
      divider: 'border-gray-200'
    }
)

usePageSeo(() => ({
  title: `${t('publicSite.market.pool.title')} - ${brand.brandName}`,
  description: t('publicSite.market.pool.description'),
  canonical: `${window.location.origin}/market`,
  keywords: t('publicSite.seo.keywords').replace(/Incudal/g, brand.brandName)
}))

function continentLabel(code: ContinentCode): string {
  return t(`hostPools.continent.${code}`)
}

function syncRouteQuery(): void {
  const query: Record<string, string> = {}
  if (selectedRegionId.value) query.region = String(selectedRegionId.value)
  if (selectedPreset.value) query.preset = selectedPreset.value
  if (selectedProductId.value) query.product = String(selectedProductId.value)
  void router.replace({ name: 'market', query })
}

/** 只有一个选项的步骤自动跳过（E2 没有核心步；某地区只有一个盘档时没有盘档步）。 */
function autoAdvance(): void {
  if (selectedRegion.value && !selectedPreset.value && presetOptions.value.length === 1) {
    selectedPreset.value = presetOptions.value[0].preset
  }
  if (selectedPreset.value && !selectedProductId.value && diskOptions.value.length === 1) {
    selectedProductId.value = diskOptions.value[0].id
  }
}

/** 把来自 URL 或旧状态的选择校验一遍：失效的层级连同下级一起清掉。 */
function reconcileSelection(): void {
  if (selectedRegionId.value && !selectedRegion.value) {
    selectedRegionId.value = null
  }
  if (!selectedRegionId.value || (selectedPreset.value && !presetOptions.value.some(option => option.preset === selectedPreset.value))) {
    selectedPreset.value = null
  }
  if (!selectedPreset.value || (selectedProductId.value && !selectedProduct.value)) {
    selectedProductId.value = null
  }
  autoAdvance()
}

function selectRegion(region: PoolCatalogRegion): void {
  if (regionIdle(region) === 0) return
  if (selectedRegionId.value !== region.id) {
    selectedRegionId.value = region.id
    selectedPreset.value = null
    selectedProductId.value = null
  }
  autoAdvance()
  syncRouteQuery()
}

function selectPreset(option: PresetOption): void {
  if (option.idle === 0) return
  if (selectedPreset.value !== option.preset) {
    selectedPreset.value = option.preset
    selectedProductId.value = null
  }
  autoAdvance()
  syncRouteQuery()
}

function selectProduct(product: PoolCatalogProduct): void {
  if (product.idle === 0) return
  selectedProductId.value = product.id
  syncRouteQuery()
}

function createInstance(): void {
  const product = selectedProduct.value
  if (!product || product.idle === 0) return

  const target = `/instances/create?poolPriceId=${product.id}`
  if (authStore.isAuthenticated) {
    void router.push(target)
    return
  }
  void router.push({ path: '/login', query: { redirect: target } })
}

async function loadCatalog(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const response = await api.packages.getPublicCatalog()
    regions.value = response.regions || []
    reconcileSelection()
    syncRouteQuery()
  } catch (error) {
    console.error('Failed to load pool catalog:', error)
    regions.value = []
    loadError.value = t('publicSite.market.pool.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadCatalog()
})
</script>

<template>
  <PublicSiteLayout>
    <div class="relative w-full">
      <section class="relative px-4 pb-10 pt-14 sm:px-6 lg:px-8">
        <div class="relative mx-auto max-w-7xl">
          <div class="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div class="max-w-3xl">
              <div class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium" :class="ui.badge">
                <span class="h-1.5 w-1.5 rounded-lg" :class="ui.badgeDot"></span>
                {{ t('publicSite.market.pool.badge') }}
              </div>
              <h1 class="mt-6 text-4xl font-normal tracking-[-0.02em] sm:text-5xl lg:text-[3.5rem] lg:leading-[1.1]" :class="ui.title">
                {{ t('publicSite.market.pool.title') }}
              </h1>
              <p class="mt-5 max-w-2xl text-base leading-7 sm:text-lg sm:leading-8" :class="ui.body">
                {{ t('publicSite.market.pool.description') }}
              </p>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-lg p-4 sm:p-5" :class="ui.summaryCard">
                <div class="text-xs font-medium" :class="ui.summaryLabel">{{ t('publicSite.market.summary.regions') }}</div>
                <div class="mt-2 text-2xl font-normal tracking-[-0.02em]" :class="ui.summaryValue">{{ regions.length }}</div>
              </div>
              <div class="rounded-lg p-4 sm:p-5" :class="ui.summaryCard">
                <div class="text-xs font-medium" :class="ui.summaryLabel">{{ t('publicSite.market.summary.total') }}</div>
                <div class="mt-2 text-2xl font-normal tracking-[-0.02em]" :class="ui.summaryValue">{{ productCount }}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="relative px-4 pb-20 sm:px-6 lg:px-8">
        <div class="mx-auto max-w-7xl">
          <div v-if="loadError" class="rounded-lg px-4 py-4 text-sm leading-6" :class="ui.errorBanner" role="alert">
            {{ loadError }}
          </div>

          <div v-else-if="loading" class="grid gap-6 lg:grid-cols-3">
            <div v-for="index in 3" :key="index" class="h-96 animate-pulse rounded-3xl" :class="ui.skeleton"></div>
          </div>

          <div v-else-if="regions.length === 0" class="rounded-3xl border border-dashed px-6 py-16 text-center text-sm" :class="ui.emptyState">
            {{ t('publicSite.market.pool.empty') }}
          </div>

          <div v-else class="grid items-start gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_minmax(300px,0.85fr)]">
            <!-- 第一步：洲 → 地区 -->
            <div class="rounded-3xl p-5 sm:p-6" :class="ui.panel">
              <div class="text-xs font-medium" :class="ui.sectionLabel">1 · {{ t('publicSite.market.pool.regionStep') }}</div>
              <div v-for="continent in continents" :key="continent.code" class="mt-5">
                <div class="text-[11px] font-medium uppercase tracking-wider" :class="ui.continentLabel">
                  {{ continentLabel(continent.code) }}
                </div>
                <div class="mt-2 space-y-2">
                  <button
                    v-for="region in continent.items"
                    :key="region.id"
                    type="button"
                    class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors duration-150"
                    :class="regionIdle(region) === 0 ? ui.optionDisabled : (selectedRegionId === region.id ? ui.optionActive : ui.optionIdle)"
                    :disabled="regionIdle(region) === 0"
                    :aria-pressed="selectedRegionId === region.id"
                    @click="selectRegion(region)"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <FlagIcon v-if="region.countryCode" :code="region.countryCode" size="xs" />
                      <span class="truncate">{{ region.name }}</span>
                    </span>
                    <span class="shrink-0 rounded-lg border px-2 py-0.5 text-[11px] font-medium" :class="regionIdle(region) === 0 ? ui.chipSoldOut : (selectedRegionId === region.id ? 'border-current' : ui.chipStock)">
                      {{ regionIdle(region) === 0 ? t('publicSite.market.pool.soldOut') : t('publicSite.market.pool.idle', { idle: regionIdle(region) }) }}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 第二、三步：机型/核心 → 磁盘档 -->
            <div class="rounded-3xl p-5 sm:p-6" :class="ui.panel">
              <template v-if="selectedRegion">
                <div class="text-xs font-medium" :class="ui.sectionLabel">2 · {{ t('publicSite.market.pool.machineStep') }}</div>
                <div class="mt-3 space-y-2">
                  <button
                    v-for="option in presetOptions"
                    :key="option.preset"
                    type="button"
                    class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors duration-150"
                    :class="option.idle === 0 ? ui.optionDisabled : (selectedPreset === option.preset ? ui.optionActive : ui.optionIdle)"
                    :disabled="option.idle === 0"
                    :aria-pressed="selectedPreset === option.preset"
                    @click="selectPreset(option)"
                  >
                    <span class="min-w-0">
                      <span class="block font-medium">{{ presetLabel(option.preset) }}</span>
                      <span class="mt-0.5 block text-xs opacity-75">{{ option.cpu }}% CPU · {{ formatMemoryMiB(option.memoryMiB) }}</span>
                    </span>
                    <span class="shrink-0 text-right">
                      <span class="block text-xs font-medium">{{ t('publicSite.market.fromMonthly', { price: formatPublicPrice(option.fromPrice) }) }}</span>
                      <span class="mt-0.5 block text-[11px] opacity-75">
                        {{ option.idle === 0 ? t('publicSite.market.pool.soldOut') : t('publicSite.market.pool.idle', { idle: option.idle }) }}
                      </span>
                    </span>
                  </button>
                </div>

                <template v-if="selectedPreset">
                  <div class="mt-6 text-xs font-medium" :class="ui.sectionLabel">3 · {{ t('publicSite.market.pool.diskStep') }}</div>
                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <button
                      v-for="product in diskOptions"
                      :key="product.id"
                      type="button"
                      class="rounded-lg px-3 py-3 text-left text-sm transition-colors duration-150"
                      :class="product.idle === 0 ? ui.optionDisabled : (selectedProductId === product.id ? ui.optionActive : ui.optionIdle)"
                      :disabled="product.idle === 0"
                      :aria-pressed="selectedProductId === product.id"
                      @click="selectProduct(product)"
                    >
                      <span class="block font-medium">{{ product.diskGiB }} GiB</span>
                      <span class="mt-0.5 block text-xs opacity-75">{{ t('publicSite.market.pool.monthly', { price: formatPublicPrice(product.monthlyPrice) }) }}</span>
                      <span class="mt-0.5 block text-[11px] opacity-75">
                        {{ product.idle === 0 ? t('publicSite.market.pool.soldOut') : t('publicSite.market.pool.idle', { idle: product.idle }) }}
                      </span>
                    </button>
                  </div>
                </template>
              </template>
              <div v-else class="flex min-h-[16rem] items-center justify-center text-center text-sm" :class="ui.muted">
                {{ t('publicSite.market.pool.chooseHint') }}
              </div>
            </div>

            <!-- 当前选择与下单 -->
            <div class="rounded-3xl p-5 sm:p-6 lg:sticky lg:top-24" :class="ui.panel">
              <div class="text-xs font-medium" :class="ui.sectionLabel">{{ t('publicSite.market.pool.selected') }}</div>
              <template v-if="selectedProduct && selectedRegion">
                <div class="mt-3 flex items-center gap-2 text-lg font-medium" :class="ui.title">
                  <FlagIcon v-if="selectedRegion.countryCode" :code="selectedRegion.countryCode" size="sm" />
                  <span>{{ selectedRegion.name }}</span>
                </div>
                <div class="mt-1 text-sm" :class="ui.body">
                  {{ presetLabel(selectedProduct.resourcePreset) }} · {{ t('publicSite.market.pool.spec', { cpu: selectedProduct.cpu, memory: formatMemoryMiB(selectedProduct.memoryMiB), disk: selectedProduct.diskGiB }) }}
                </div>

                <div class="mt-5 border-t pt-4" :class="ui.divider">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="text-sm" :class="ui.muted">{{ t('hostPools.monthlyPrice') }}</span>
                    <span class="text-2xl font-normal tracking-[-0.02em]" :class="ui.title">{{ t('publicSite.market.pool.monthly', { price: formatPublicPrice(selectedProduct.monthlyPrice) }) }}</span>
                  </div>
                  <div class="mt-2 flex items-baseline justify-between gap-3 text-sm">
                    <span :class="ui.muted">{{ t('hostPools.setupFee') }}</span>
                    <span :class="ui.body">
                      {{ selectedProduct.setupFee > 0 ? t('publicSite.market.pool.setupFee', { price: formatPublicPrice(selectedProduct.setupFee) }) : t('publicSite.market.pool.noSetupFee') }}
                    </span>
                  </div>
                  <div class="mt-2 text-xs" :class="ui.muted">
                    {{ t('publicSite.market.pool.idle', { idle: selectedProduct.idle }) }}
                  </div>
                </div>

                <button
                  type="button"
                  class="mt-6 inline-flex h-10 w-full items-center justify-center rounded-lg px-6 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
                  :class="ui.cta"
                  :disabled="selectedProduct.idle === 0"
                  @click="createInstance"
                >
                  {{ authStore.isAuthenticated ? t('publicSite.market.pool.createNow') : t('publicSite.market.pool.loginToOrder') }}
                </button>
                <p v-if="!authStore.isAuthenticated" class="mt-3 text-center text-xs leading-5" :class="ui.muted">
                  {{ t('publicSite.market.pool.loginHint') }}
                </p>
              </template>
              <div v-else class="flex min-h-[12rem] items-center justify-center text-center text-sm" :class="ui.muted">
                {{ t('publicSite.market.pool.chooseHint') }}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </PublicSiteLayout>
</template>
