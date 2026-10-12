<script setup lang="ts">
/**
 * 结算页（一机一卖购物车）
 *
 * 打开时重新拉商品目录，逐行比对：已下架、价格变动、库存不足都提前标出来；
 * 真正的裁决在付款事务里（整单全有或全无）。允许删行、改数量、改前缀，不允许改配置。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import api from '@/api'
import FlagIcon from '@/components/FlagIcon.vue'
import { useCartStore, type CartItem } from '@/stores/cart'
import { useConfigStore } from '@/stores/config'
import { useInstanceResourcesStore } from '@/stores/instanceResources'
import { useThemeStore } from '@/stores/theme'
import { useToast } from '@/stores/toast'
import { translateError } from '@/utils/errorHandler'
import { validateName } from '@/utils/validation'
import {
  buildPoolInstanceNames,
  formatMemoryMiB,
  formatPublicPrice,
  presetLabel,
  type PoolCatalogProduct,
  type PoolCatalogRegion
} from '@/utils/publicCatalog'

defineOptions({ name: 'CheckoutView' })

const router = useRouter()
const { t } = useI18n()
const themeStore = useThemeStore()
const toast = useToast()
const cartStore = useCartStore()
const configStore = useConfigStore()
const resourcesStore = useInstanceResourcesStore()
const { sshKeys } = storeToRefs(resourcesStore)

const regions = ref<PoolCatalogRegion[]>([])
const loading = ref(true)
const paying = ref(false)
const error = ref('')
const sshKeyId = ref<number | null>(null)
/** 付款被拒后服务端给出的真实余量，覆盖目录里的数字 */
const serverAvailable = ref<Record<number, number>>({})

interface CheckoutRow {
  item: CartItem
  region: PoolCatalogRegion | null
  live: PoolCatalogProduct | null
  offSale: boolean
  priceChanged: boolean
  available: number
  stockShort: boolean
  names: string[]
  nameError: string
  subtotalCents: number
}

function findLive(poolPriceId: number): { region: PoolCatalogRegion; product: PoolCatalogProduct } | null {
  for (const region of regions.value) {
    const product = region.products.find(entry => entry.id === poolPriceId)
    if (product) return { region, product }
  }
  return null
}

const rows = computed<CheckoutRow[]>(() => {
  const seenNames = new Set<string>()
  return cartStore.items.map(item => {
    const found = findLive(item.poolPriceId)
    const live = found?.product ?? null
    const unitCents = live ? live.monthlyPrice + live.setupFee : 0
    const priceChanged = !!live && (live.monthlyPrice !== item.snapshot.monthlyPrice || live.setupFee !== item.snapshot.setupFee)
    const available = serverAvailable.value[item.poolPriceId] ?? live?.idle ?? 0
    const names = buildPoolInstanceNames(item.namePrefix.trim(), item.quantity)

    let nameError = ''
    for (const name of names) {
      const validation = validateName(name)
      if (!validation.valid) { nameError = validation.message || t('cart.nameInvalid'); break }
      if (seenNames.has(name)) { nameError = t('cart.nameDuplicate', { name }); break }
      seenNames.add(name)
    }

    return {
      item,
      region: found?.region ?? null,
      live,
      offSale: !live,
      priceChanged,
      available,
      stockShort: !!live && available < item.quantity,
      names,
      nameError,
      subtotalCents: unitCents * item.quantity
    }
  })
})

const totalQuantity = computed(() => cartStore.totalQuantity)
const totalCents = computed(() => rows.value.reduce((sum, row) => sum + row.subtotalCents, 0))
const maxInstances = computed(() => configStore.poolOrderMaxInstances)
const tooMany = computed(() => totalQuantity.value > maxInstances.value)
const blocked = computed(() => rows.value.some(row => row.offSale || row.stockShort || !!row.nameError))
const canPay = computed(() => rows.value.length > 0 && !blocked.value && !tooMany.value && sshKeyId.value !== null && !paying.value && !loading.value)

async function loadCatalog(): Promise<void> {
  const response = await api.packages.getPublicCatalog()
  regions.value = response.regions || []
  serverAvailable.value = {}
}

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([configStore.loadPublicConfig(), resourcesStore.loadSshKeys(), loadCatalog()])
    if (sshKeys.value.length > 0) sshKeyId.value = sshKeys.value[0].id
  } catch (err) {
    error.value = translateError(err)
  } finally {
    loading.value = false
  }
})

function updateQuantity(row: CheckoutRow, value: number): void {
  const upper = Math.max(1, Math.min(row.available || 1, maxInstances.value))
  cartStore.setQuantity(row.item.key, Math.min(Math.max(1, Math.floor(value || 1)), upper))
}

async function pay(): Promise<void> {
  if (!canPay.value || sshKeyId.value === null) return
  paying.value = true
  error.value = ''
  try {
    const result = await api.instances.poolOrder({
      items: rows.value.map(row => ({
        poolPriceId: row.item.poolPriceId,
        quantity: row.item.quantity,
        namePrefix: row.item.namePrefix.trim(),
        image: row.item.image,
        customInitCommandIds: row.item.customInitCommandIds.length > 0 ? row.item.customInitCommandIds : undefined
      })),
      sshKeyId: sshKeyId.value,
      expectedTotal: totalCents.value
    })
    cartStore.clear()
    toast.success(t('cart.success', { count: result.instances.length }))
    router.push('/instances')
  } catch (err: any) {
    const data = err?.response?.data ?? err
    const code = data?.code
    if (code === 'POOL_STOCK_SHORT' && Array.isArray(data?.shortages)) {
      const next: Record<number, number> = {}
      for (const shortage of data.shortages as Array<{ poolPriceId: number; available: number }>) {
        next[shortage.poolPriceId] = shortage.available
      }
      serverAvailable.value = next
      error.value = t('cart.stockShortError')
    } else if (code === 'POOL_PRICE_CHANGED') {
      await loadCatalog().catch(() => {})
      error.value = t('cart.priceChangedError')
    } else {
      error.value = translateError(err)
    }
  } finally {
    paying.value = false
  }
}
</script>

<template>
  <div class="space-y-4 animate-fade-in">
    <div class="page-header gap-3">
      <div class="min-w-0">
        <h1 class="page-title">{{ t('cart.title') }}</h1>
        <p class="page-description">{{ t('cart.description') }}</p>
      </div>
      <router-link to="/market" class="btn-secondary whitespace-nowrap">{{ t('cart.goShopping') }}</router-link>
    </div>

    <div v-if="loading" class="card p-8 text-center text-sm text-themed-muted">{{ t('common.loading') }}</div>

    <div v-else-if="rows.length === 0" class="card p-12 text-center">
      <p class="text-sm text-themed-secondary">{{ t('cart.empty') }}</p>
      <router-link to="/market" class="btn-primary inline-flex mt-5">{{ t('cart.goShopping') }}</router-link>
    </div>

    <template v-else>
      <div class="space-y-3">
        <div
          v-for="row in rows"
          :key="row.item.key"
          class="card p-4 space-y-3"
          :class="row.offSale || row.stockShort || row.nameError ? (themeStore.isDark ? 'border border-red-500/40' : 'border border-red-300') : ''"
        >
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 space-y-1">
              <div class="flex items-center gap-2 text-base font-medium text-themed">
                <FlagIcon v-if="row.item.snapshot.countryCode" :code="row.item.snapshot.countryCode" size="xs" />
                <span class="truncate">{{ row.region?.name || row.item.snapshot.regionName }}</span>
                <span class="text-xs font-normal text-themed-muted">{{ presetLabel(row.item.snapshot.resourcePreset) }} · {{ row.item.snapshot.diskGiB }} GiB</span>
              </div>
              <div class="text-xs text-themed-muted">
                {{ row.item.snapshot.cpu }}% CPU · {{ formatMemoryMiB(row.item.snapshot.memoryMiB) }} · {{ row.item.snapshot.imageLabel }}
              </div>
              <div class="text-xs text-themed-muted">
                {{ t('cart.line.unit') }}：
                <template v-if="row.live">
                  ¥{{ formatPublicPrice(row.live.monthlyPrice) }}{{ row.live.setupFee > 0 ? ` + ¥${formatPublicPrice(row.live.setupFee)}` : '' }}
                </template>
                <template v-else>-</template>
              </div>
            </div>
            <div class="text-right shrink-0">
              <div class="text-lg font-semibold text-themed">¥{{ formatPublicPrice(row.subtotalCents) }}</div>
              <button type="button" class="text-xs text-red-500 hover:underline mt-1" @click="cartStore.remove(row.item.key)">{{ t('cart.line.remove') }}</button>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <label class="text-xs text-themed-muted">
              {{ t('cart.line.quantity') }}
              <input
                :value="row.item.quantity"
                type="number" min="1" :max="Math.max(1, Math.min(row.available || 1, maxInstances))" step="1"
                class="input w-full mt-1"
                :disabled="row.offSale"
                @change="updateQuantity(row, Number(($event.target as HTMLInputElement).value))"
              />
            </label>
            <label class="text-xs text-themed-muted">
              {{ row.item.quantity > 1 ? t('cart.line.namePrefix') : t('cart.line.name') }}
              <input
                :value="row.item.namePrefix"
                type="text" maxlength="60"
                class="input w-full mt-1"
                @input="cartStore.setNamePrefix(row.item.key, ($event.target as HTMLInputElement).value)"
              />
              <span v-if="row.item.quantity > 1 && !row.nameError" class="block mt-1 text-[11px]">{{ row.names.slice(0, 3).join(', ') }}{{ row.names.length > 3 ? ' …' : '' }}</span>
            </label>
          </div>

          <p v-if="row.offSale" class="text-xs text-red-500">{{ t('cart.flags.offSale') }}</p>
          <p v-else-if="row.stockShort" class="text-xs text-red-500">{{ t('cart.flags.stockShort', { available: row.available }) }}</p>
          <p v-if="row.priceChanged && row.live" class="text-xs text-amber-600 dark:text-amber-400">
            {{ t('cart.flags.priceChanged', { price: formatPublicPrice(row.live.monthlyPrice + row.live.setupFee) }) }}
          </p>
          <p v-if="row.nameError" class="text-xs text-red-500">{{ row.nameError }}</p>
        </div>
      </div>

      <div class="card p-5 space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="text-sm text-themed-secondary">
            {{ t('cart.sshKey') }}
            <select v-model="sshKeyId" class="input w-full mt-1" :disabled="sshKeys.length === 0">
              <option v-for="key in sshKeys" :key="key.id" :value="key.id">{{ key.name || `#${key.id}` }}</option>
            </select>
            <span v-if="sshKeys.length === 0" class="block mt-1 text-xs text-red-500">{{ t('cart.noSshKey') }}</span>
          </label>
          <div class="text-right">
            <div class="text-xs text-themed-muted">{{ t('cart.count', { count: totalQuantity }) }}</div>
            <div class="text-sm text-themed-muted mt-1">{{ t('cart.total') }}</div>
            <div class="text-3xl font-bold text-themed">¥{{ formatPublicPrice(totalCents) }}</div>
          </div>
        </div>

        <p v-if="tooMany" class="text-xs text-red-500">{{ t('cart.tooMany', { max: maxInstances }) }}</p>
        <p class="text-xs text-themed-muted leading-relaxed">{{ t('cart.notice') }}</p>
        <div v-if="error" class="p-3 rounded-lg border text-sm" :class="themeStore.isDark ? 'bg-red-900/20 border-red-500/30 text-red-400' : 'bg-red-50 border-red-200 text-red-700'">{{ error }}</div>
        <button type="button" class="btn-primary w-full" :disabled="!canPay" @click="pay">
          {{ paying ? t('cart.paying') : t('cart.pay') }}
        </button>
      </div>
    </template>
  </div>
</template>
