<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import { useCartStore } from '@/stores/cart'

const router = useRouter()
const { t } = useI18n()
const themeStore = useThemeStore()
const cartStore = useCartStore()

const count = computed(() => cartStore.totalQuantity)
</script>

<template>
  <button
    class="relative p-1.5 rounded transition-colors touch-target"
    :class="themeStore.isDark ? 'hover:bg-gray-800 text-gray-500 hover:text-gray-300' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'"
    :title="t('cart.title')"
    :aria-label="t('cart.title')"
    @click="router.push('/checkout')"
  >
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
    </svg>
    <span
      v-if="count > 0"
      class="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-medium text-white bg-blue-500 rounded-full"
    >
      {{ count > 99 ? '99+' : count }}
    </span>
  </button>
</template>
