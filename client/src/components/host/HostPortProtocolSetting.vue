<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useToast } from '@/stores/toast'
import type { HostPortProtocolState, PortProtocol } from '@/types/api'
const props = defineProps<{ hostId: number }>()
const { t } = useI18n()
const toast = useToast()
const state = ref<HostPortProtocolState | null>(null)
const selected = ref<PortProtocol>('tcp_udp')
const busy = ref(false)
const loadFailed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let sequence = 0

async function load(initial = false) {
  clearTimeout(timer)
  const current = ++sequence
  try {
    const result = await api.hosts.getPortProtocol(props.hostId)
    if (disposed || current !== sequence) return
    state.value = result
    loadFailed.value = false
    if (initial) selected.value = result.requested
  } catch {
    if (!disposed && current === sequence) loadFailed.value = true
  } finally {
    if (!disposed && current === sequence) timer = setTimeout(() => load(), state.value?.status === 'applied' ? 15000 : 5000)
  }
}
async function save() {
  busy.value = true
  clearTimeout(timer)
  try {
    await api.hosts.setPortProtocol(props.hostId, selected.value)
    toast.success(t('portProtocol.queued'))
    await load()
  } catch (error: unknown) {
    const upgradeRequired = error && typeof error === 'object' && 'code' in error && error.code === 'HOST_AGENT_UPGRADE_REQUIRED'
    toast.error(t(upgradeRequired ? 'portProtocol.upgradeRequired' : 'portProtocol.saveFailed'))
  } finally { busy.value = false }
}
onMounted(() => load(true))
watch(() => props.hostId, () => { state.value = null; void load(true) })
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <section class="mb-6 pb-6 border-b border-themed">
    <h3 class="text-sm font-medium text-themed">{{ t('portProtocol.title') }}</h3>
    <p class="text-xs text-themed-muted mt-1 mb-3">{{ t('portProtocol.description') }}</p>
    <div class="flex flex-wrap items-center gap-3">
      <select v-model="selected" class="input w-40" :disabled="!state?.supported || busy" :aria-label="t('portProtocol.title')">
        <option value="tcp">{{ t('portProtocol.tcp') }}</option>
        <option value="tcp_udp">{{ t('portProtocol.tcp_udp') }}</option>
      </select>
      <button type="button" class="btn-primary whitespace-nowrap" :disabled="!state?.supported || busy || (selected === state.requested && state.status !== 'failed')" @click="save">{{ t(busy ? 'common.saving' : 'common.save') }}</button>
      <span v-if="state" class="text-xs text-themed-muted">{{ t('portProtocol.current', { protocol: t(`portProtocol.${state.applied}`) }) }} · {{ t(`portProtocol.${state.status}`) }}</span>
    </div>
    <p v-if="state && !state.supported" class="text-xs text-amber-600 dark:text-amber-400 mt-2">{{ t('portProtocol.upgradeRequired') }}</p>
    <p v-if="state?.error" class="text-xs text-red-600 dark:text-red-400 mt-2">{{ t('portProtocol.applyFailed') }}</p>
    <button v-if="loadFailed" type="button" class="btn btn-secondary mt-2" @click="load(true)">{{ t('common.retry') }}</button>
  </section>
</template>
