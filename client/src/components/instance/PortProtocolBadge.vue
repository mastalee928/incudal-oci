<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PortProtocolState } from '@/types/api'
defineProps<{ value?: PortProtocolState }>()
const { t } = useI18n()
</script>

<template>
  <span v-if="value" class="inline-flex flex-wrap items-center gap-1 text-xs" :title="t('portProtocol.description')">
    <span class="rounded px-1.5 py-0.5 bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200">{{ t(`portProtocol.${value.applied}`) }}</span>
    <span v-if="value.status !== 'applied'" class="text-amber-600 dark:text-amber-400">{{ t(`portProtocol.${value.status}`) }}</span>
  </span>
</template>
