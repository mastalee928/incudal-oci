<script setup lang="ts">
/**
 * 落地页 / 门户页（一机一卖）
 *
 * 上半是品牌与能力介绍，下半直接内嵌购买向导（与购买页同一套：洲 → 国家 → 机型 →
 * 核心 → 硬盘 → 镜像 → 凭据 → 付款）。数据源：/packages/public/catalog。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { usePageSeo } from '@/composables/usePageSeo'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { useBrand } from '@/composables/useBrand'
import PoolPurchaseWizard from '@/components/purchase/PoolPurchaseWizard.vue'
import { formatPublicPrice } from '@/utils/publicCatalog'

defineOptions({
  name: 'PortalView'
})

const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const brand = useBrand()

const regions = ref<Array<{ products: Array<{ monthlyPrice: number; resourcePreset: string }> }>>([])
const loading = ref(true)

const allProducts = computed(() => regions.value.flatMap(region => region.products))

const minMonthlyPrice = computed<number | null>(() => {
  if (allProducts.value.length === 0) return null
  return allProducts.value.reduce((min, product) => Math.min(min, product.monthlyPrice), allProducts.value[0].monthlyPrice)
})

const statCards = computed(() => [
  { label: t('publicSite.market.summary.regions'), value: String(regions.value.length) },
  { label: t('publicSite.market.summary.total'), value: String(allProducts.value.length) },
  { label: t('hostPools.core'), value: String(new Set(allProducts.value.map(product => product.resourcePreset)).size) },
  { label: t('hostPools.monthlyPrice'), value: minMonthlyPrice.value === null ? '-' : `¥${formatPublicPrice(minMonthlyPrice.value)}` }
])

const platformCards = computed(() => [
  { title: t('publicSite.portal.experienceNoLoginTitle'), description: t('publicSite.portal.experienceNoLoginDescription') },
  { title: t('publicSite.portal.experienceRoutingTitle'), description: t('publicSite.portal.experienceRoutingDescription') },
  { title: t('publicSite.portal.experienceThemeTitle'), description: t('publicSite.portal.experienceThemeDescription') }
])

const consoleActionLabel = computed(() => (
  authStore.isAuthenticated ? t('publicSite.actions.console') : t('publicSite.actions.signIn')
))

const consoleActionCompactLabel = computed(() => (
  authStore.isAuthenticated ? t('publicSite.actions.consoleCompact') : t('publicSite.actions.signIn')
))

const ui = computed(() => themeStore.isDark
  ? {
      badge: 'border-gray-800 bg-gray-950 text-gray-300', body: 'text-gray-400',
      primaryButton: 'bg-white text-gray-900 hover:bg-gray-100 focus-visible:ring-white/20',
      secondaryButton: 'border border-gray-800 text-gray-100 hover:bg-gray-900 focus-visible:ring-gray-700',
      statCard: 'border border-gray-800 bg-gray-950', statValue: 'text-gray-100', statLabel: 'text-gray-500',
      previewCard: 'border border-gray-800 bg-gray-950 text-gray-100', previewLabel: 'text-gray-500', previewTitle: 'text-gray-100',
      previewButton: 'bg-white text-gray-900 hover:bg-gray-100', previewBody: 'text-gray-400',
      terminalCard: 'border border-gray-800 bg-black text-gray-300', terminalMeta: 'text-gray-600',
      platformCard: 'border border-gray-800 bg-gray-900 text-gray-100', platformTitle: 'text-gray-100', platformBody: 'text-gray-400',
      sectionLabel: 'text-gray-500', sectionBody: 'text-gray-400',
      browseWrap: 'border border-gray-800 bg-gray-950', skeleton: 'bg-gray-800'
    }
  : {
      badge: 'border-gray-200 bg-white text-gray-600', body: 'text-gray-600',
      primaryButton: 'bg-gray-900 text-white hover:bg-gray-700 focus-visible:ring-gray-900/20',
      secondaryButton: 'border border-gray-300 text-gray-900 hover:bg-gray-100 focus-visible:ring-gray-300',
      statCard: 'border border-gray-200 bg-white shadow-sm', statValue: 'text-gray-900', statLabel: 'text-gray-500',
      previewCard: 'border border-gray-200 bg-white text-gray-900 shadow-sm', previewLabel: 'text-gray-500', previewTitle: 'text-gray-900',
      previewButton: 'bg-gray-900 text-white hover:bg-gray-700', previewBody: 'text-gray-600',
      terminalCard: 'border border-gray-800 bg-gray-950 text-gray-200', terminalMeta: 'text-gray-500',
      platformCard: 'border border-gray-200 bg-gray-50 text-gray-900', platformTitle: 'text-gray-900', platformBody: 'text-gray-600',
      sectionLabel: 'text-gray-500', sectionBody: 'text-gray-600',
      browseWrap: 'border border-gray-200 bg-gray-50', skeleton: 'bg-gray-200'
    }
)

usePageSeo(() => ({
  title: `${brand.brandName} - ${brand.brandSubtitle}`,
  description: brand.brandSubtitle,
  canonical: `${window.location.origin}/`,
  keywords: t('publicSite.seo.keywords').replace(/Incudal/g, brand.brandName)
}))

function browseCatalog(): void {
  void router.push({ path: '/market' })
}

function goToConsole(): void {
  if (authStore.isAuthenticated) {
    void router.push(authStore.isAdmin ? '/admin/users' : '/dashboard')
    return
  }
  void router.push('/login')
}

async function loadCatalog(): Promise<void> {
  loading.value = true
  try {
    const response = await api.packages.getPublicCatalog()
    regions.value = response.regions || []
  } catch (error) {
    console.error('Failed to load public catalog:', error)
    regions.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadCatalog() })
</script>

<template>
  <div class="relative">
    <section class="relative px-4 pb-20 pt-14 sm:px-6 lg:px-8">
      <div class="relative mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div class="max-w-3xl">
          <div class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium" :class="ui.badge">
            <span class="h-1.5 w-1.5 rounded-lg" :class="themeStore.isDark ? 'bg-[#a8c7fa]' : 'bg-[#0b57d0]'"></span>
            {{ t('publicSite.market.pool.badge') }}
          </div>

          <h1 class="mt-6 text-4xl font-normal tracking-[-0.02em] sm:text-5xl lg:text-[3.5rem] lg:leading-[1.1]">
            {{ t('publicSite.portal.title') }}
          </h1>
          <p class="mt-6 max-w-2xl text-base leading-7 sm:text-lg sm:leading-8" :class="ui.body">
            {{ t('publicSite.portal.description') }}
          </p>

          <div class="mt-8 flex flex-col gap-3 sm:flex-row">
            <button class="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-6 text-sm font-medium tracking-[0.01em] transition-[background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-4" :class="ui.primaryButton" @click="browseCatalog()">
              <span>{{ t('publicSite.actions.browseProducts') }}</span>
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.5 4.5l6 6m0 0l-6 6m6-6h-15" />
              </svg>
            </button>
            <button class="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-6 text-sm font-medium tracking-[0.01em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-4" :class="ui.secondaryButton" @click="goToConsole">
              <span class="sm:hidden">{{ consoleActionCompactLabel }}</span>
              <span class="hidden sm:inline">{{ consoleActionLabel }}</span>
            </button>
          </div>

          <div class="mt-10 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <div v-for="item in statCards" :key="item.label" class="rounded-lg px-4 py-4 transition-shadow duration-150" :class="ui.statCard">
              <div class="text-xs font-medium" :class="ui.statLabel">{{ item.label }}</div>
              <div class="mt-2 text-2xl font-normal tracking-[-0.02em]" :class="ui.statValue">{{ item.value }}</div>
            </div>
          </div>
        </div>

        <div class="relative">
          <div class="relative overflow-hidden rounded-xl p-6" :class="ui.previewCard">
            <div class="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div class="text-xs font-medium" :class="ui.previewLabel">{{ t('publicSite.portal.previewLabel') }}</div>
                <div class="mt-2 text-2xl font-normal tracking-[-0.02em]" :class="ui.previewTitle">{{ t('publicSite.portal.previewTitle') }}</div>
              </div>
              <button class="h-10 rounded-lg px-5 text-sm font-medium transition-colors duration-150" :class="ui.previewButton" @click="browseCatalog()">
                {{ t('publicSite.actions.viewCatalog') }}
              </button>
            </div>

            <p class="mt-4 text-sm leading-6" :class="ui.previewBody">{{ t('publicSite.portal.previewDescription') }}</p>

            <div class="mt-6 rounded-lg p-5 font-mono text-xs leading-6" :class="ui.terminalCard">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span>root@incudal</span>
                <span :class="ui.terminalMeta">incus console</span>
              </div>
              <div class="mt-4 space-y-1">
                <div>{{ t('publicSite.portal.controlPoint1') }}</div>
                <div>{{ t('publicSite.portal.controlPoint2') }}</div>
                <div>{{ t('publicSite.portal.controlPoint3') }}</div>
              </div>
            </div>

            <div class="mt-6 grid gap-3 sm:grid-cols-3">
              <div v-for="card in platformCards" :key="card.title" class="rounded-lg p-4 transition-colors duration-150" :class="ui.platformCard">
                <div class="text-sm font-medium" :class="ui.platformTitle">{{ card.title }}</div>
                <p class="mt-2 text-xs leading-5" :class="ui.platformBody">{{ card.description }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="px-4 pb-20 sm:px-6 lg:px-8">
      <div class="mx-auto max-w-7xl rounded-xl px-6 py-10 sm:px-10" :class="ui.browseWrap">
        <div class="max-w-2xl">
          <div class="text-xs font-medium" :class="ui.sectionLabel">{{ t('publicSite.portal.browseLabel') }}</div>
          <h2 class="mt-4 text-3xl font-normal tracking-[-0.02em] sm:text-[2.25rem] sm:leading-[1.15]">{{ t('publicSite.market.pool.title') }}</h2>
          <p class="mt-4 text-base leading-7" :class="ui.sectionBody">{{ t('publicSite.market.pool.description') }}</p>
          <p class="mt-2 text-sm" :class="ui.sectionLabel">
            {{ t('publicSite.market.pool.regionsCount', { count: regions.length }) }} · {{ t('publicSite.market.pool.productsCount', { count: allProducts.length }) }}
          </p>
        </div>
        <div class="mt-8">
          <PoolPurchaseWizard embedded />
        </div>
      </div>
    </section>
  </div>
</template>
