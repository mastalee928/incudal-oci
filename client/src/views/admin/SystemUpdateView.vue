<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import type { SystemUpdateCheckResponse, SystemUpdateStatusResponse } from '@/types/api'
import { useToast } from '@/stores/toast'
import { copyToClipboard } from '@/utils/clipboard'

const { t, te, locale } = useI18n()
const toast = useToast()
const source = ref(localStorage.getItem('incudal.update.source') || 'https://github.com/mastalee928/incudal-oci')
const status = ref<SystemUpdateStatusResponse | null>(null)
const checked = ref<SystemUpdateCheckResponse | null>(null)
const checking = ref(false)
const applying = ref(false)
const reconnecting = ref(false)
const execution = computed(() => status.value?.execution)
const running = computed(() => applying.value || execution.value?.status === 'running')
const canApply = computed(() => !!status.value?.executorAvailable && !!checked.value?.updateAvailable &&
  checked.value.latest.commit !== status.value.currentCommit && checked.value.latest.ci.status === 'success' && !checking.value && !running.value)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

function errorText(error: unknown) {
  const code = typeof error === 'string' ? error : error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return te('panelUpdate.errors.' + code) ? t('panelUpdate.errors.' + code) : t('admin.systemUpdate.applyFailed')
}
function normalizeSource() {
  source.value = source.value.trim().replace(/\/+$/, '')
  localStorage.setItem('incudal.update.source', source.value)
  return source.value
}
async function copyManualCommand() {
  if (!status.value?.manualCommand) return
  if (await copyToClipboard(status.value.manualCommand)) toast.success(t('common.copied'))
  else toast.error(t('common.copyFailed'))
}
async function refresh() {
  clearTimeout(timer)
  try {
    const result = await api.systemUpdate.status(normalizeSource())
    if (disposed) return
    if (running.value && (!result.executorAvailable || !result.execution)) {
      reconnecting.value = true
      return
    }
    status.value = result
    reconnecting.value = false
    applying.value = result.execution?.status === 'running'
  } catch (error) {
    if (running.value) reconnecting.value = true
    else if (!disposed) toast.error(errorText(error))
  } finally {
    if (!disposed && running.value) timer = setTimeout(() => void refresh(), 3000)
  }
}
async function check() {
  if (checking.value || running.value) return
  checking.value = true
  checked.value = null
  try {
    const result = await api.systemUpdate.check(normalizeSource())
    if (!disposed) checked.value = result
    await refresh()
  } catch (error) { if (!disposed) toast.error(errorText(error)) }
  finally { checking.value = false }
}
async function apply() {
  if (!canApply.value || !checked.value) return
  const target = checked.value.latest.commit
  if (!window.confirm(t('panelUpdate.confirm', { commit: target.slice(0, 12) }))) return
  applying.value = true
  try {
    const result = await api.systemUpdate.apply(normalizeSource(), target)
    if (disposed) return
    if (status.value) status.value.execution = result.execution
    toast.success(t('admin.systemUpdate.started'))
    await refresh()
  } catch (error) { applying.value = false; if (!disposed) toast.error(errorText(error)) }
}
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString(locale.value) : '—' }
onMounted(() => void refresh())
onUnmounted(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <div class="space-y-4">
    <div class="page-header gap-3">
      <div><h1 class="page-title">{{ t('admin.systemUpdate.title') }}</h1><p class="page-description">{{ t('panelUpdate.description') }}</p></div>
      <button class="btn-secondary whitespace-nowrap" @click="refresh">{{ t('common.refresh') }}</button>
    </div>
    <section class="card p-4 space-y-3">
      <label class="block text-sm text-themed" for="update-source">{{ t('admin.systemUpdate.sourceLabel') }}</label>
      <input id="update-source" v-model="source" class="input w-full font-mono text-sm" :disabled="running" @input="checked = null" />
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-themed-muted mr-auto">{{ t('panelUpdate.branch') }}: main</span>
        <button class="btn-secondary whitespace-nowrap" :disabled="checking || running" @click="check">{{ t(checking ? 'admin.systemUpdate.checking' : 'admin.systemUpdate.check') }}</button>
        <button class="btn-primary whitespace-nowrap" :disabled="!canApply" @click="apply">{{ t(running ? 'admin.systemUpdate.updating' : 'admin.systemUpdate.updateNow') }}</button>
      </div>
    </section>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <section class="card p-4 space-y-2">
        <h2 class="font-medium text-themed">{{ t('panelUpdate.currentCommit') }}</h2>
        <p class="font-mono text-sm break-all text-themed">{{ status?.currentCommit || t('panelUpdate.unknownCommit') }}</p>
      </section>
      <section class="card p-4 space-y-2">
        <h2 class="font-medium text-themed">{{ t('panelUpdate.targetCommit') }}</h2>
        <template v-if="checked">
          <a :href="checked.latest.url" target="_blank" rel="noopener noreferrer" class="block font-mono text-sm break-all text-blue-600 dark:text-blue-400">{{ checked.latest.commit }}</a>
          <p class="text-sm text-themed break-words">{{ checked.latest.name }}</p>
          <p class="text-xs text-themed-muted">{{ date(checked.latest.publishedAt) }}</p>
          <p class="text-sm" :class="checked.latest.ci.status === 'success' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">{{ t('panelUpdate.ciLabel') }}: {{ t('panelUpdate.ci.' + checked.latest.ci.status) }} <a v-if="checked.latest.ci.url" :href="checked.latest.ci.url" target="_blank" rel="noopener noreferrer" class="underline ml-2">{{ t('common.details') }}</a></p>
          <p v-if="status?.currentCommit === checked.latest.commit" class="text-xs text-themed-muted">{{ t('admin.systemUpdate.alreadyLatest') }}</p>
        </template>
        <p v-else class="text-sm text-themed-muted">{{ t('admin.systemUpdate.checkHint') }}</p>
      </section>
    </div>
    <section v-if="status && !status.executorAvailable" class="card p-4 space-y-3">
      <p class="text-sm text-amber-600 dark:text-amber-400">
        {{ t('panelUpdate.setupRequired') }}
        <a href="https://github.com/mastalee928/incudal-oci#升级现有部署" target="_blank" rel="noopener noreferrer" class="underline">{{ t('common.details') }}</a>
      </p>
      <div v-if="status.manualCommand" class="flex flex-col gap-2 sm:flex-row sm:items-start">
        <code class="min-w-0 flex-1 rounded-lg bg-gray-950 p-3 text-xs text-gray-200 break-all">{{ status.manualCommand }}</code>
        <button type="button" class="btn-secondary whitespace-nowrap" @click="copyManualCommand">{{ t('common.copy') }}</button>
      </div>
    </section>
    <section v-if="execution" class="card p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-medium text-themed">{{ t('admin.systemUpdate.executionTitle') }}</h2><span class="text-sm text-themed">{{ t('admin.systemUpdate.execution.' + execution.status) }}</span></div>
      <p class="text-sm text-themed">{{ t('panelUpdate.phases.' + execution.phase) }}</p>
      <p class="text-xs text-themed-muted break-all">{{ t('panelUpdate.targetCommit') }}: {{ execution.targetCommit }}</p>
      <p class="text-xs text-themed-muted">{{ date(execution.startedAt) }}<template v-if="execution.finishedAt"> → {{ date(execution.finishedAt) }}</template></p>
      <p v-if="reconnecting" class="text-sm text-themed-muted">{{ t('panelUpdate.reconnecting') }}</p>
      <p v-if="execution.error" class="text-sm text-red-600 dark:text-red-400">{{ errorText(execution.error) }}</p>
      <p v-if="execution.rollbackSucceeded !== undefined" class="text-sm text-themed">{{ t(execution.rollbackSucceeded ? 'panelUpdate.recovered' : 'panelUpdate.recoveryFailed') }}</p>
    </section>
    <p class="text-xs text-themed-muted">{{ t('panelUpdate.backupHint') }}</p>
  </div>
</template>
