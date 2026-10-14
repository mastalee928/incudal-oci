<script setup lang="ts">
/**
 * 结算页（一机一卖购物车）
 *
 * 打开时重新拉商品目录，逐行比对：已下架、价格变动、库存不足都提前标出来；
 * 真正的裁决在付款事务里（整单全有或全无）。允许删行、改数量、改前缀，不允许改配置。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
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
/** 认证方式：整单共用。key = 选一把 SSH 密钥；password = 系统生成 root 密码。 */
const authMode = ref<'key' | 'password'>('key')
/** 付款成功后的凭据：密码模式显示 root 密码与 SSH 端口，密钥模式只提示。 */
const credentials = ref<{ passwordMode: boolean; lines: Array<{ id: number; name: string; host: string; sshPort: number | null; rootPassword: string | null }> } | null>(null)
const copied = ref<number | null>(null)

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
  // 同一商品可能被加进购物车多次（多行）；库存要按该商品的总需求量比对，
  // 否则「两行各 1 台、池子只剩 1 台」会被逐行判成不缺货，付款被拒时也找不到行可提示。
  const requestedByProduct = new Map<number, number>()
  for (const item of cartStore.items) {
    requestedByProduct.set(item.poolPriceId, (requestedByProduct.get(item.poolPriceId) ?? 0) + item.quantity)
  }
  return cartStore.items.map(item => {
    const found = findLive(item.poolPriceId)
    const live = found?.product ?? null
    const unitCents = live ? live.monthlyPrice + live.setupFee : 0
    const priceChanged = !!live && (live.monthlyPrice !== item.snapshot.monthlyPrice || live.setupFee !== item.snapshot.setupFee)
    const available = serverAvailable.value[item.poolPriceId] ?? live?.idle ?? 0
    const requested = requestedByProduct.get(item.poolPriceId) ?? item.quantity
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
      stockShort: !!live && available < requested,
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
/** 有问题的行：已下架 / 库存不足 / 名称不合法。付款时会就地拦下并引导处理。 */
const problemRows = computed(() => rows.value.filter(row => row.offSale || row.stockShort || !!row.nameError))
/** 付款按钮只在「空车 / 未选密钥 / 付款中 / 加载中」时禁用；缺货等问题留给点击时就地引导。 */
const canPay = computed(() => rows.value.length > 0 && (authMode.value === 'password' || sshKeyId.value !== null) && !paying.value && !loading.value)

/** 正在抖动的行 key，用于「滚到那一行并抖一下」的提示。 */
const shakingKey = ref<string | null>(null)

/** 滚到该行并左右抖一下，提醒用户处理这一行。 */
function highlightRow(key: string): void {
  const el = document.getElementById(`cart-row-${key}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  shakingKey.value = null
  // 下一帧再设，保证连续点同一行也能重新触发动画。
  void nextTick(() => { shakingKey.value = key })
  window.setTimeout(() => { if (shakingKey.value === key) shakingKey.value = null }, 900)
}

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
  if (!canPay.value) return

  if (tooMany.value) {
    error.value = t('cart.tooMany', { max: maxInstances.value })
    return
  }

  // 缺货 / 已下架 / 名称不合法：不直接拒付，滚到第一行问题商品并抖一下，就地提示。
  const problem = problemRows.value[0]
  if (problem) {
    error.value = ''
    highlightRow(problem.item.key)
    return
  }

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
      sshKeyId: authMode.value === 'key' ? sshKeyId.value ?? undefined : undefined,
      expectedTotal: totalCents.value
    })
    cartStore.clear()
    toast.success(t('cart.success', { count: result.instances.length }))
    // 密码模式下把 root 密码摆到用户眼前；密钥模式只提示已按所选密钥开通。
    credentials.value = {
      passwordMode: authMode.value === 'password',
      lines: result.instances.map(entry => ({
        id: entry.id, name: entry.name, host: entry.host, sshPort: entry.sshPort,
        rootPassword: authMode.value === 'password' ? entry.rootPassword : null
      }))
    }
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
      // 按服务端给的真实余量重算后，滚到第一行缺货商品并抖动。
      await nextTick()
      const firstShort = rows.value.find(row => row.stockShort)
      if (firstShort) highlightRow(firstShort.item.key)
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

async function copyCredential(line: { id: number; rootPassword: string | null }): Promise<void> {
  if (!line.rootPassword) return
  try {
    await navigator.clipboard.writeText(line.rootPassword)
    copied.value = line.id
    window.setTimeout(() => { if (copied.value === line.id) copied.value = null }, 1500)
  } catch { /* clipboard unavailable */ }
}

function finishCredentials(): void {
  credentials.value = null
  void router.push('/instances')
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
          :id="`cart-row-${row.item.key}`"
          :key="row.item.key"
          class="card p-4 space-y-3"
          :class="[
            row.offSale || row.stockShort || row.nameError ? (themeStore.isDark ? 'border border-red-500/40' : 'border border-red-300') : '',
            shakingKey === row.item.key ? 'cart-shake' : ''
          ]"
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
          <p v-else-if="row.stockShort" class="text-xs text-red-500">{{ row.available <= 0 ? t('cart.flags.stockEmpty') : t('cart.flags.stockShort', { available: row.available }) }}</p>
          <p v-if="row.priceChanged && row.live" class="text-xs text-amber-600 dark:text-amber-400">
            {{ t('cart.flags.priceChanged', { price: formatPublicPrice(row.live.monthlyPrice + row.live.setupFee) }) }}
          </p>
          <p v-if="row.nameError" class="text-xs text-red-500">{{ row.nameError }}</p>
        </div>
      </div>

      <div class="card p-5 space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-2">
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-sm transition-colors"
                :class="authMode === 'key' ? 'border-blue-500 text-themed' : 'border-themed text-themed-muted'"
                @click="authMode = 'key'"
              >
                {{ t('publicSite.market.pool.authKey') }}
              </button>
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-sm transition-colors"
                :class="authMode === 'password' ? 'border-blue-500 text-themed' : 'border-themed text-themed-muted'"
                @click="authMode = 'password'"
              >
                {{ t('publicSite.market.pool.authPassword') }}
              </button>
            </div>
            <label v-if="authMode === 'key'" class="block text-sm text-themed-secondary">
              {{ t('cart.sshKey') }}
              <select v-model="sshKeyId" class="input w-full mt-1" :disabled="sshKeys.length === 0">
                <option v-for="key in sshKeys" :key="key.id" :value="key.id">{{ key.name || `#${key.id}` }}</option>
              </select>
              <span v-if="sshKeys.length === 0" class="block mt-1 text-xs text-red-500">{{ t('cart.noSshKey') }}</span>
            </label>
            <p v-else class="text-xs text-themed-muted">{{ t('publicSite.market.pool.authPasswordHint') }}</p>
          </div>
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

  <!-- 付款成功后的凭据：密码模式展示 root 密码，密钥模式只提示 -->
  <Teleport to="body">
    <div v-if="credentials" class="modal-overlay" @keydown.esc="finishCredentials">
      <div class="modal-backdrop" @click="finishCredentials"></div>
      <section class="modal-content" role="dialog" aria-modal="true">
        <div class="modal-header"><h2 class="modal-title">{{ t('publicSite.market.pool.credsTitle') }}</h2></div>
        <div class="modal-body space-y-3">
          <p v-if="!credentials.passwordMode" class="text-sm text-themed">{{ t('publicSite.market.pool.credsKeyMode') }}</p>
          <div v-for="line in credentials.lines" :key="line.id" class="rounded-lg border border-themed p-3 space-y-1">
            <div class="text-sm font-medium text-themed">{{ line.name }} <span class="text-themed-muted">· {{ line.host }}</span></div>
            <div class="text-xs text-themed-muted">{{ t('publicSite.market.pool.credsPort') }}: <span class="font-mono text-themed">{{ line.sshPort ?? 22 }}</span></div>
            <div v-if="line.rootPassword" class="flex items-center justify-between gap-2 text-xs">
              <span class="text-themed-muted">{{ t('publicSite.market.pool.credsPassword') }}: <span class="font-mono text-themed break-all">{{ line.rootPassword }}</span></span>
              <button type="button" class="btn-secondary text-xs whitespace-nowrap" @click="copyCredential(line)">{{ copied === line.id ? t('publicSite.market.pool.credsCopied') : t('publicSite.market.pool.credsCopy') }}</button>
            </div>
          </div>
        </div>
        <div class="modal-footer"><button type="button" class="btn-primary" @click="finishCredentials">{{ t('publicSite.market.pool.credsViewInstances') }}</button></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 缺货商品框左右抖动：付款被拦下时就地提醒用户处理这一行。 */
@keyframes cart-shake {
  0%, 100% { transform: translateX(0); }
  15% { transform: translateX(-8px); }
  30% { transform: translateX(7px); }
  45% { transform: translateX(-6px); }
  60% { transform: translateX(4px); }
  75% { transform: translateX(-2px); }
}
.cart-shake {
  animation: cart-shake 0.7s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}
@media (prefers-reduced-motion: reduce) {
  .cart-shake { animation: none; }
}
</style>
