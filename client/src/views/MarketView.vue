<script setup lang="ts">
/**
 * 购买页（一机一卖）——承载完整购买向导。
 * 层级：洲 → 国家/地区 → 机型(E2/ARM) → (ARM 核心) → 硬盘档 → 镜像 → 凭据 → 付款。
 * 向导组件自包含（加载目录、逐步库存灰显、登录门槛、下单与凭据展示）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { usePageSeo } from '@/composables/usePageSeo'
import { useBrand } from '@/composables/useBrand'
import PublicSiteLayout from '@/components/public/PublicSiteLayout.vue'
import PoolPurchaseWizard from '@/components/purchase/PoolPurchaseWizard.vue'
import { useThemeStore } from '@/stores/theme'

defineOptions({ name: 'MarketView' })

const { t } = useI18n()
const themeStore = useThemeStore()
const brand = useBrand()

const regions = ref<Array<{ products: Array<{ id: number }> }>>([])
const productCount = computed(() => regions.value.reduce((sum, region) => sum + region.products.length, 0))

const ui = computed(() => themeStore.isDark
  ? {
      badge: 'border-gray-800 bg-gray-950 text-gray-300',
      badgeDot: 'bg-white',
      title: 'text-gray-100',
      body: 'text-gray-400',
      summaryCard: 'border border-gray-800 bg-gray-950',
      summaryLabel: 'text-gray-500',
      summaryValue: 'text-gray-100'
    }
  : {
      badge: 'border-gray-200 bg-white text-gray-600',
      badgeDot: 'bg-gray-900',
      title: 'text-gray-900',
      body: 'text-gray-600',
      summaryCard: 'border border-gray-200 bg-white shadow-sm',
      summaryLabel: 'text-gray-500',
      summaryValue: 'text-gray-900'
    }
)

usePageSeo(() => ({
  title: `${t('publicSite.market.pool.title')} - ${brand.brandName}`,
  description: t('publicSite.market.pool.description'),
  canonical: `${window.location.origin}/market`,
  keywords: t('publicSite.seo.keywords').replace(/Incudal/g, brand.brandName)
}))

onMounted(async () => {
  try {
    const response = await api.packages.getPublicCatalog()
    regions.value = response.regions || []
  } catch (error) {
    console.error('Failed to load pool catalog:', error)
    regions.value = []
  }
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
          <PoolPurchaseWizard />
        </div>
      </section>
    </div>
  </PublicSiteLayout>
</template>
