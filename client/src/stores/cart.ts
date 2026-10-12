/**
 * 购物车（一机一卖）
 *
 * 一行 = 一种配置 + 数量。只存在浏览器里，按账号隔离；不占库存，也不锁价。
 * 行里的 snapshot 只用于展示与比对，付款时以服务端当前价与库存为准。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface CartItemSnapshot {
  regionId: number
  regionName: string
  countryCode: string | null
  resourcePreset: string
  diskGiB: number
  cpu: number
  memoryMiB: number
  /** 分 */
  monthlyPrice: number
  /** 分 */
  setupFee: number
  imageLabel: string
}

export interface CartItem {
  key: string
  poolPriceId: number
  quantity: number
  namePrefix: string
  image: string
  customInitCommandIds: number[]
  snapshot: CartItemSnapshot
  addedAt: string
}

const STORAGE_PREFIX = 'incudal.cart.'

function isCartItem(value: unknown): value is CartItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<CartItem>
  return typeof item.key === 'string'
    && Number.isInteger(item.poolPriceId)
    && Number.isInteger(item.quantity) && (item.quantity as number) >= 1
    && typeof item.namePrefix === 'string'
    && typeof item.image === 'string'
    && Array.isArray(item.customInitCommandIds)
    && !!item.snapshot && typeof item.snapshot === 'object'
}

export const useCartStore = defineStore('cart', () => {
  const authStore = useAuthStore()
  const items = ref<CartItem[]>([])

  // 按账号隔离：切换账号时自动换存储键，看不到别人的购物车
  const storageKey = computed(() => (authStore.user?.id ? `${STORAGE_PREFIX}${authStore.user.id}` : null))

  function load(): void {
    if (!storageKey.value) {
      items.value = []
      return
    }
    try {
      const raw = localStorage.getItem(storageKey.value)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      items.value = Array.isArray(parsed) ? parsed.filter(isCartItem) : []
    } catch {
      items.value = []
    }
  }

  function persist(): void {
    if (!storageKey.value) return
    try {
      if (items.value.length === 0) localStorage.removeItem(storageKey.value)
      else localStorage.setItem(storageKey.value, JSON.stringify(items.value))
    } catch {
      // 存储满了或被禁用：购物车退化为仅内存，不影响下单
    }
  }

  watch(storageKey, load, { immediate: true })
  watch(items, persist, { deep: true })

  const totalQuantity = computed(() => items.value.reduce((sum, item) => sum + item.quantity, 0))
  /** 按加入时的展示价算的合计（分），结算页会用服务端价重算 */
  const totalCents = computed(() => items.value.reduce(
    (sum, item) => sum + item.quantity * (item.snapshot.monthlyPrice + item.snapshot.setupFee), 0))

  function add(input: Omit<CartItem, 'key' | 'addedAt'>): CartItem {
    const item: CartItem = {
      ...input,
      key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      addedAt: new Date().toISOString()
    }
    items.value = [...items.value, item]
    return item
  }

  function remove(key: string): void {
    items.value = items.value.filter(item => item.key !== key)
  }

  function setQuantity(key: string, quantity: number): void {
    const next = Math.max(1, Math.floor(quantity))
    items.value = items.value.map(item => (item.key === key ? { ...item, quantity: next } : item))
  }

  function setNamePrefix(key: string, namePrefix: string): void {
    items.value = items.value.map(item => (item.key === key ? { ...item, namePrefix } : item))
  }

  function clear(): void {
    items.value = []
  }

  return { items, totalQuantity, totalCents, add, remove, setQuantity, setNamePrefix, clear, reload: load }
})
