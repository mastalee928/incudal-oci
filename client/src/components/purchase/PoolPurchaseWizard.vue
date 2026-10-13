<script setup lang="ts">
/**
 * 一机一卖购买向导（购买页与首页共用）
 *
 * 步骤：洲 → 国家/地区 → 机型（E2 / ARM；选 ARM 再分 1C/2C/3C/4C）→ 硬盘档
 *      → 镜像 → SSH 密钥/密码 → 付款。
 * 每一步都按目录里的真实库存灰显无货项；只有一个选项的步骤自动跳过。
 * 镜像起需要登录：未登录时给出「登录后继续」，登录回来按 URL query 复原选择。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import FlagIcon from '@/components/FlagIcon.vue'
import ImageSelector from '@/components/instance/ImageSelector.vue'
import SSHKeySelector from '@/components/instance/SSHKeySelector.vue'
import { useAuthStore } from '@/stores/auth'
import { useCartStore } from '@/stores/cart'
import { useConfigStore } from '@/stores/config'
import { useInstanceResourcesStore } from '@/stores/instanceResources'
import { useToast } from '@/stores/toast'
import { translateError } from '@/utils/errorHandler'
import { validateName } from '@/utils/validation'
import { groupByContinent, type ContinentCode } from '@/utils/countryContinent'
import {
  architectureOfPreset,
  buildPoolInstanceNames,
  formatMemoryMiB,
  formatPublicPrice,
  parsePackageIdQuery,
  presetCores,
  presetFamily,
  presetLabel,
  presetOf,
  type PoolCatalogProduct,
  type PoolCatalogRegion
} from '@/utils/publicCatalog'

defineOptions({ name: 'PoolPurchaseWizard' })

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const toast = useToast()
const cartStore = useCartStore()
const configStore = useConfigStore()
const resourcesStore = useInstanceResourcesStore()
const { sshKeys } = storeToRefs(resourcesStore)

const p = (key: string) => t(`publicSite.market.pool.${key}`)

const regions = ref<PoolCatalogRegion[]>([])
const loading = ref(true)
const loadError = ref('')

const regionId = ref<number | null>(parsePackageIdQuery(route.query.region))
const family = ref<'E2' | 'ARM' | null>(null)
const cores = ref<number | null>(null)
const productId = ref<number | null>(parsePackageIdQuery(route.query.product))
const image = ref('')
const authMode = ref<'key' | 'password'>('key')
const sshKeyId = ref<number | null>(null)
const name = ref('')
const quantity = ref(1)

const images = ref<Array<{ value: string; label: string; icon: string | null }>>([])
const imagesLoading = ref(false)
const paying = ref(false)
const formError = ref('')

interface CredentialLine { id: number; name: string; host: string; sshPort: number | null; rootPassword: string | null }
const credentials = ref<{ passwordMode: boolean; lines: CredentialLine[] } | null>(null)
const copied = ref<number | null>(null)

// ── 目录与层级 ────────────────────────────────────────────────
const continents = computed(() => groupByContinent(regions.value))
const regionIdle = (region: PoolCatalogRegion) => region.products.reduce((sum, item) => sum + item.idle, 0)
const currentRegion = computed(() => regions.value.find(region => region.id === regionId.value) || null)

interface FamilyOption { family: 'E2' | 'ARM'; idle: number; fromPrice: number }
const familyOptions = computed<FamilyOption[]>(() => {
  const region = currentRegion.value
  if (!region) return []
  const order: Array<'E2' | 'ARM'> = ['E2', 'ARM']
  const byFamily = new Map<'E2' | 'ARM', FamilyOption>()
  for (const product of region.products) {
    const key = presetFamily(product.resourcePreset)
    const existing = byFamily.get(key)
    if (existing) { existing.idle += product.idle; existing.fromPrice = Math.min(existing.fromPrice, product.monthlyPrice) }
    else byFamily.set(key, { family: key, idle: product.idle, fromPrice: product.monthlyPrice })
  }
  return order.filter(key => byFamily.has(key)).map(key => byFamily.get(key)!)
})

const needsCores = computed(() => family.value === 'ARM')
interface CoreOption { cores: number; idle: number; fromPrice: number }
const coreOptions = computed<CoreOption[]>(() => {
  const region = currentRegion.value
  if (!region || family.value !== 'ARM') return []
  const byCores = new Map<number, CoreOption>()
  for (const product of region.products) {
    if (presetFamily(product.resourcePreset) !== 'ARM') continue
    const value = presetCores(product.resourcePreset)
    if (value === null) continue
    const existing = byCores.get(value)
    if (existing) { existing.idle += product.idle; existing.fromPrice = Math.min(existing.fromPrice, product.monthlyPrice) }
    else byCores.set(value, { cores: value, idle: product.idle, fromPrice: product.monthlyPrice })
  }
  return [...byCores.values()].sort((left, right) => left.cores - right.cores)
})

const preset = computed<string | null>(() => (family.value ? presetOf(family.value, cores.value) : null))

const diskOptions = computed<PoolCatalogProduct[]>(() => {
  if (!currentRegion.value || !preset.value) return []
  return currentRegion.value.products
    .filter(product => product.resourcePreset === preset.value)
    .sort((left, right) => left.diskGiB - right.diskGiB)
})
const selectedProduct = computed<PoolCatalogProduct | null>(() =>
  diskOptions.value.find(product => product.id === productId.value) || null)

const names = computed<string[]>(() => buildPoolInstanceNames(name.value.trim(), quantity.value))
const unitCents = computed(() => (selectedProduct.value ? selectedProduct.value.monthlyPrice + selectedProduct.value.setupFee : 0))
const totalCents = computed(() => unitCents.value * quantity.value)
const maxQuantity = computed(() =>
  Math.max(1, Math.min(selectedProduct.value?.idle ?? 1, configStore.poolOrderMaxInstances)))
watch([quantity, maxQuantity], ([value, max]) => {
  const clamped = Math.min(Math.max(1, Math.floor(value || 1)), max)
  if (clamped !== value) quantity.value = clamped
})

const needsLogin = computed(() => !authStore.isAuthenticated)
const nameValid = computed(() => !!name.value.trim() && validateName(name.value.trim()).valid)
const canPay = computed(() => !!selectedProduct.value && selectedProduct.value.idle > 0 && !!image.value &&
  nameValid.value && !paying.value && quantity.value <= maxQuantity.value &&
  (authMode.value === 'password' || sshKeyId.value !== null))

// ── 选择动作 ────────────────────────────────────────────────
function syncQuery(): void {
  const query: Record<string, string> = {}
  if (regionId.value) query.region = String(regionId.value)
  if (preset.value) query.preset = preset.value
  if (productId.value) query.product = String(productId.value)
  void router.replace({ query })
}

function selectRegion(region: PoolCatalogRegion): void {
  if (regionIdle(region) === 0) return
  if (regionId.value !== region.id) { regionId.value = region.id; family.value = null; cores.value = null; productId.value = null }
  autoAdvance()
  syncQuery()
}
function selectFamily(option: FamilyOption): void {
  if (option.idle === 0) return
  if (family.value !== option.family) { family.value = option.family; cores.value = null; productId.value = null }
  autoAdvance()
  syncQuery()
}
function selectCores(option: CoreOption): void {
  if (option.idle === 0) return
  if (cores.value !== option.cores) { cores.value = option.cores; productId.value = null }
  autoAdvance()
  syncQuery()
}
function selectProduct(product: PoolCatalogProduct): void {
  if (product.idle === 0) return
  productId.value = product.id
  syncQuery()
}

/** 只有一个选项就自动选中（E2 没有核心步；某机型只有一个盘档时没有盘档步）。 */
function autoAdvance(): void {
  if (currentRegion.value && !family.value && familyOptions.value.length === 1) family.value = familyOptions.value[0].family
  if (family.value === 'ARM' && cores.value === null && coreOptions.value.length === 1) cores.value = coreOptions.value[0].cores
  if (preset.value && !productId.value && diskOptions.value.length === 1) productId.value = diskOptions.value[0].id
}

function reconcile(): void {
  // 只带 product（例如从旧 ?poolPriceId= 链接跳来）时，反推出地区/机型/核心。
  if (productId.value && !regions.value.some(region => region.id === regionId.value && region.products.some(item => item.id === productId.value))) {
    for (const region of regions.value) {
      const product = region.products.find(item => item.id === productId.value)
      if (product) {
        regionId.value = region.id
        family.value = presetFamily(product.resourcePreset)
        cores.value = presetCores(product.resourcePreset)
        break
      }
    }
  }
  if (regionId.value && !currentRegion.value) regionId.value = null
  if (!currentRegion.value) { family.value = null; cores.value = null; productId.value = null; return }
  if (family.value && !familyOptions.value.some(option => option.family === family.value)) { family.value = null; cores.value = null; productId.value = null }
  if (family.value === 'ARM' && cores.value !== null && !coreOptions.value.some(option => option.cores === cores.value)) { cores.value = null; productId.value = null }
  if (productId.value && !selectedProduct.value) productId.value = null
  const presetFromQuery = typeof route.query.preset === 'string' ? route.query.preset : null
  if (presetFromQuery && !family.value) {
    const fam = presetFamily(presetFromQuery)
    if (familyOptions.value.some(option => option.family === fam)) {
      family.value = fam
      if (fam === 'ARM') cores.value = presetCores(presetFromQuery)
    }
  }
  autoAdvance()
}

// ── 镜像 ────────────────────────────────────────────────────
async function loadImages(): Promise<void> {
  if (!authStore.isAuthenticated || !selectedProduct.value) { images.value = []; image.value = ''; return }
  imagesLoading.value = true
  try {
    const architecture = architectureOfPreset(selectedProduct.value.resourcePreset)
    const response = await api.images.getSystemImages('container', selectedProduct.value.memoryMiB)
    const list = (response.images || [])
      .filter(entry => entry.architecture === architecture)
      .map(entry => ({ value: entry.remoteAlias, label: entry.name, icon: entry.icon || null }))
    images.value = list
    if (!list.some(entry => entry.value === image.value)) image.value = list[0]?.value ?? ''
  } catch {
    images.value = []
    image.value = ''
  } finally {
    imagesLoading.value = false
  }
}
watch(selectedProduct, () => { void loadImages() })

// ── 提交 ────────────────────────────────────────────────────
function goLogin(): void {
  const redirect = `${window.location.pathname}${window.location.search}`
  void router.push({ path: '/login', query: { redirect } })
}

function addToCart(): void {
  const product = selectedProduct.value
  const region = currentRegion.value
  if (!product || !region || !image.value || !nameValid.value) return
  const imageLabel = images.value.find(entry => entry.value === image.value)?.label || image.value
  cartStore.add({
    poolPriceId: product.id,
    quantity: quantity.value,
    namePrefix: name.value.trim(),
    image: image.value,
    customInitCommandIds: [],
    snapshot: {
      regionId: region.id,
      regionName: region.name,
      countryCode: region.countryCode,
      resourcePreset: product.resourcePreset,
      diskGiB: product.diskGiB,
      cpu: product.cpu,
      memoryMiB: product.memoryMiB,
      monthlyPrice: product.monthlyPrice,
      setupFee: product.setupFee,
      imageLabel
    }
  })
  toast.success(p('addedToCart'))
}

async function pay(): Promise<void> {
  if (!canPay.value || !selectedProduct.value) return
  paying.value = true
  formError.value = ''
  try {
    const result = await api.instances.poolOrder({
      items: [{
        poolPriceId: selectedProduct.value.id,
        quantity: quantity.value,
        namePrefix: name.value.trim(),
        image: image.value,
        customInitCommandIds: undefined
      }],
      sshKeyId: authMode.value === 'key' ? sshKeyId.value : undefined,
      expectedTotal: totalCents.value
    })
    credentials.value = {
      passwordMode: authMode.value === 'password',
      lines: result.instances.map(entry => ({ id: entry.id, name: entry.name, host: entry.host, sshPort: entry.sshPort, rootPassword: authMode.value === 'password' ? entry.rootPassword : null }))
    }
  } catch (error) {
    formError.value = translateError(error)
  } finally {
    paying.value = false
  }
}

async function copyLine(line: CredentialLine): Promise<void> {
  const text = line.rootPassword || ''
  if (!text) return
  try { await navigator.clipboard.writeText(text); copied.value = line.id; setTimeout(() => { if (copied.value === line.id) copied.value = null }, 1500) } catch { /* clipboard unavailable */ }
}

function finish(): void {
  credentials.value = null
  void router.push('/instances')
}

async function loadCatalog(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await configStore.loadPublicConfig()
    const response = await api.packages.getPublicCatalog()
    regions.value = response.regions || []
    reconcile()
    if (authStore.isAuthenticated) {
      await resourcesStore.loadSshKeys()
      if (sshKeys.value.length > 0) sshKeyId.value = sshKeys.value[0].id
    }
  } catch (error) {
    console.error('Failed to load pool catalog:', error)
    regions.value = []
    loadError.value = p('loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(() => { void loadCatalog() })
</script>

<template>
  <section :class="props.embedded ? 'space-y-4' : 'space-y-5'">
    <div v-if="loadError" class="card p-4 text-sm text-red-600 dark:text-red-400" role="alert">{{ loadError }}</div>
    <div v-else-if="loading" class="card p-8 text-center text-sm text-themed-muted">{{ t('common.loading') }}</div>

    <div v-else-if="!regions.length" class="card p-8 text-center text-sm text-themed-muted">{{ p('empty') }}</div>

    <div v-else class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)] lg:items-start">
      <!-- 左：步骤 -->
      <div class="space-y-4 min-w-0">
        <!-- 1 · 位置（洲） -->
        <div class="card p-4">
          <div class="text-xs font-medium text-themed-muted">1 · {{ p('stepLocation') }}</div>
          <div class="mt-3 space-y-3">
            <div v-for="continent in continents" :key="continent.code">
              <div class="text-[11px] font-medium uppercase tracking-wider text-themed-muted">{{ t(`hostPools.continent.${continent.code as ContinentCode}`) }}</div>
              <div class="mt-2 grid gap-2 sm:grid-cols-2">
                <button
                  v-for="region in continent.items" :key="region.id" type="button"
                  class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors"
                  :class="regionIdle(region) === 0 ? 'border-themed opacity-50 cursor-not-allowed' : (regionId === region.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-themed hover:border-blue-400')"
                  :disabled="regionIdle(region) === 0" @click="selectRegion(region)"
                >
                  <span class="flex min-w-0 items-center gap-2"><FlagIcon v-if="region.countryCode" :code="region.countryCode" size="xs" /><span class="truncate text-themed">{{ region.name }}</span></span>
                  <span class="shrink-0 text-[11px] text-themed-muted">{{ regionIdle(region) === 0 ? p('soldOut') : p('idle').replace('{idle}', String(regionIdle(region))) }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 2 · 机型（E2 / ARM） -->
        <div v-if="currentRegion" class="card p-4">
          <div class="text-xs font-medium text-themed-muted">2 · {{ p('stepMachine') }}</div>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              v-for="option in familyOptions" :key="option.family" type="button"
              class="flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left text-sm transition-colors"
              :class="option.idle === 0 ? 'border-themed opacity-50 cursor-not-allowed' : (family === option.family ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-themed hover:border-blue-400')"
              :disabled="option.idle === 0" @click="selectFamily(option)"
            >
              <span class="font-medium text-themed">{{ option.family === 'E2' ? p('familyE2') : p('familyArm') }}</span>
              <span class="text-right text-xs text-themed-muted">{{ t('publicSite.market.fromMonthly', { price: formatPublicPrice(option.fromPrice) }) }}<br />{{ option.idle === 0 ? p('soldOut') : p('idle').replace('{idle}', String(option.idle)) }}</span>
            </button>
          </div>
        </div>

        <!-- 3 · ARM 核心数 -->
        <div v-if="currentRegion && needsCores" class="card p-4">
          <div class="text-xs font-medium text-themed-muted">3 · {{ p('stepCores') }}</div>
          <div class="mt-3 grid gap-2 sm:grid-cols-4">
            <button
              v-for="option in coreOptions" :key="option.cores" type="button"
              class="rounded-lg border px-3 py-3 text-center text-sm transition-colors"
              :class="option.idle === 0 ? 'border-themed opacity-50 cursor-not-allowed' : (cores === option.cores ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-themed hover:border-blue-400')"
              :disabled="option.idle === 0" @click="selectCores(option)"
            >
              <span class="block font-medium text-themed">{{ p('cores').replace('{n}', String(option.cores)) }}</span>
              <span class="mt-0.5 block text-[11px] text-themed-muted">{{ option.idle === 0 ? p('soldOut') : p('idle').replace('{idle}', String(option.idle)) }}</span>
            </button>
          </div>
        </div>

        <!-- 4 · 硬盘档 -->
        <div v-if="preset && diskOptions.length > 1" class="card p-4">
          <div class="text-xs font-medium text-themed-muted">{{ needsCores ? '4' : '3' }} · {{ p('stepDisk') }}</div>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              v-for="product in diskOptions" :key="product.id" type="button"
              class="rounded-lg border px-3 py-3 text-left text-sm transition-colors"
              :class="product.idle === 0 ? 'border-themed opacity-50 cursor-not-allowed' : (productId === product.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : 'border-themed hover:border-blue-400')"
              :disabled="product.idle === 0" @click="selectProduct(product)"
            >
              <span class="block font-medium text-themed">{{ product.diskGiB }} GiB</span>
              <span class="mt-0.5 block text-xs text-themed-muted">{{ t('publicSite.market.pool.monthly', { price: formatPublicPrice(product.monthlyPrice) }) }} · {{ product.idle === 0 ? p('soldOut') : p('idle').replace('{idle}', String(product.idle)) }}</span>
            </button>
          </div>
        </div>

        <!-- 登录门槛：镜像及以后需要登录 -->
        <div v-if="selectedProduct && needsLogin" class="card p-4">
          <p class="text-sm text-themed">{{ p('loginHint') }}</p>
          <button type="button" class="btn-primary w-full mt-3" @click="goLogin">{{ p('loginToOrder') }}</button>
        </div>

        <template v-if="selectedProduct && !needsLogin">
          <!-- 5 · 镜像 -->
          <ImageSelector
            :available-images="images" :selected-image="image" :images-loading="imagesLoading"
            :step-number="6" :title="p('stepImage')" :empty-message="p('empty')"
            @update:selected-image="image = $event"
          />

          <!-- 6 · 凭据：密钥 / 密码 -->
          <div class="card p-5">
            <div class="text-xs font-medium text-themed-muted mb-3">7 · {{ p('stepAuth') }}</div>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="rounded-lg border px-3 py-2 text-sm" :class="authMode === 'key' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-themed' : 'border-themed text-themed-muted'" @click="authMode = 'key'">{{ p('authKey') }}</button>
              <button type="button" class="rounded-lg border px-3 py-2 text-sm" :class="authMode === 'password' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950 text-themed' : 'border-themed text-themed-muted'" @click="authMode = 'password'">{{ p('authPassword') }}</button>
            </div>
            <div v-if="authMode === 'key'" class="mt-3">
              <SSHKeySelector :ssh-keys="sshKeys" :selected-key-id="sshKeyId" :step-number="0" :title="p('authKey')" @update:selected-key-id="sshKeyId = $event" />
            </div>
            <p v-else class="mt-3 text-xs text-themed-muted">{{ p('authPasswordHint') }}</p>
          </div>
        </template>
      </div>

      <!-- 右：订单与付款 -->
      <div class="card p-5 space-y-4 lg:sticky lg:top-20">
        <div class="text-xs font-medium text-themed-muted">{{ p('selected') }}</div>
        <template v-if="selectedProduct && currentRegion">
          <div class="flex items-center gap-2 text-base font-medium text-themed">
            <FlagIcon v-if="currentRegion.countryCode" :code="currentRegion.countryCode" size="sm" />
            <span class="truncate">{{ currentRegion.name }}</span>
          </div>
          <div class="text-sm text-themed-muted">{{ presetLabel(selectedProduct.resourcePreset) }} · {{ t('publicSite.market.pool.spec', { cpu: selectedProduct.cpu, memory: formatMemoryMiB(selectedProduct.memoryMiB), disk: selectedProduct.diskGiB }) }}</div>

          <label class="block text-sm text-themed-secondary" :class="quantity > 1 ? '' : ''">
            {{ quantity > 1 ? t('cart.line.namePrefix') : t('instance.createPage.instanceName') }}
            <input v-model="name" type="text" maxlength="60" class="input w-full mt-1" :placeholder="t('instance.createPage.instanceNamePlaceholder')" />
          </label>
          <p v-if="name && quantity > 1" class="text-[11px] text-themed-muted">{{ t('instance.createPage.pool.namePreview', { count: names.length, names: names.slice(0, 3).join(', ') }) }}</p>

          <div class="flex items-center gap-3">
            <label class="text-sm text-themed-secondary whitespace-nowrap">{{ t('instance.createPage.pool.quantity') }}</label>
            <input v-model.number="quantity" type="number" min="1" :max="maxQuantity" step="1" class="input w-24" />
            <span class="text-xs text-themed-muted">{{ t('instance.createPage.pool.quantityHint', { max: maxQuantity }) }}</span>
          </div>

          <div class="border-t border-themed pt-3 space-y-1">
            <div class="flex justify-between text-sm"><span class="text-themed-muted">{{ t('hostPools.monthlyPrice') }}</span><span class="text-themed">¥{{ formatPublicPrice(selectedProduct.monthlyPrice) }}<template v-if="quantity > 1"> × {{ quantity }}</template></span></div>
            <div class="flex justify-between text-sm"><span class="text-themed-muted">{{ t('hostPools.setupFee') }}</span><span class="text-themed">{{ selectedProduct.setupFee > 0 ? `¥${formatPublicPrice(selectedProduct.setupFee)}` : p('noSetupFee') }}</span></div>
            <div class="flex items-center justify-between pt-2"><span class="text-sm font-medium text-themed">{{ t('instance.createPage.pool.total') }}</span><span class="text-2xl font-bold text-themed">¥{{ formatPublicPrice(totalCents) }}</span></div>
          </div>

          <p v-if="formError" class="text-xs text-red-500">{{ formError }}</p>

          <div v-if="!needsLogin" class="space-y-2">
            <button type="button" class="btn-secondary w-full" :disabled="!canPay" @click="addToCart">{{ t('instance.createPage.pool.addToCart') }}</button>
            <button type="button" class="btn-primary w-full" :disabled="!canPay" @click="pay">{{ paying ? t('cart.paying') : t('instance.createPage.pool.payNow') }}</button>
          </div>
          <button v-else type="button" class="btn-primary w-full" @click="goLogin">{{ p('loginToOrder') }}</button>
        </template>
        <p v-else class="text-sm text-themed-muted">{{ p('chooseHint') }}</p>
      </div>
    </div>

    <!-- 凭据弹窗 -->
    <Teleport to="body">
      <div v-if="credentials" class="modal-overlay" @keydown.esc="finish">
        <div class="modal-backdrop" @click="finish"></div>
        <section class="modal-content" role="dialog" aria-modal="true">
          <div class="modal-header"><h2 class="modal-title">{{ p('credsTitle') }}</h2></div>
          <div class="modal-body space-y-3">
            <p v-if="!credentials.passwordMode" class="text-sm text-themed">{{ p('credsKeyMode') }}</p>
            <div v-for="line in credentials.lines" :key="line.id" class="rounded-lg border border-themed p-3 space-y-1">
              <div class="text-sm font-medium text-themed">{{ line.name }} <span class="text-themed-muted">· {{ line.host }}</span></div>
              <div class="text-xs text-themed-muted">{{ p('credsPort') }}: <span class="font-mono text-themed">{{ line.sshPort ?? 22 }}</span></div>
              <div v-if="line.rootPassword" class="flex items-center justify-between gap-2 text-xs">
                <span class="text-themed-muted">{{ p('credsPassword') }}: <span class="font-mono text-themed break-all">{{ line.rootPassword }}</span></span>
                <button type="button" class="btn-secondary text-xs whitespace-nowrap" @click="copyLine(line)">{{ copied === line.id ? p('credsCopied') : p('credsCopy') }}</button>
              </div>
            </div>
          </div>
          <div class="modal-footer"><button type="button" class="btn-primary" @click="finish">{{ p('credsViewInstances') }}</button></div>
        </section>
      </div>
    </Teleport>
  </section>
</template>
