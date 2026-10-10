<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useToast } from '@/stores/toast'
import { availableFlagCountryCodes, getLocalizedCountryName } from '@/utils/countryDisplay'
import { OnboardingCsvError, parseHostOnboardingCsv } from '@/utils/hostOnboardingCsv'
import HostInventoryPanel from '@/components/host/HostInventoryPanel.vue'
import type { OnboardingBatch, OnboardingCredentials, OnboardingDefaults, OnboardingGatewayStatus, OnboardingNode, OnboardingStatus, OnboardingTargetInput } from '@/types/api'

const { t, te, locale } = useI18n()
const toast = useToast()
const activeTab = ref<'hosts' | 'tasks'>('hosts')
const inventory = ref<InstanceType<typeof HostInventoryPanel> | null>(null)
const batches = ref<OnboardingBatch[]>([])
const gateway = ref<OnboardingGatewayStatus | null>(null)
const gatewaySshHost = ref<string | null>(null)
const loading = ref(true)
const loadFailed = ref(false)
const search = ref('')
const page = ref(1)
const total = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / 10)))
const expanded = ref<string | null>(null)
const showCreate = ref(false)
const createMode = ref<'single' | 'batch'>('single')
const firstCreateInput = ref<HTMLInputElement | null>(null)
const hostAddress = ref('')
const sshPort = ref(22)
const sshFingerprint = ref('')
const machineSuggestions = ref(['E2', 'ARM'])
const regionSuggestions = ref<string[]>([])
const submitting = ref(false)
const actionNodeId = ref<string | null>(null)
const retryNode = ref<OnboardingNode | null>(null)
const sshNode = ref<OnboardingNode | null>(null)
const requestId = ref(crypto.randomUUID())
const batchName = ref('')
const accountLabel = ref('')
const initialDefaults = (): OnboardingDefaults => ({ countryCode: 'us', storageSize: 30, cpuAllowanceMax: 200, memoryMax: 768, portProtocol: 'tcp_udp' })
const defaults = ref<OnboardingDefaults>(initialDefaults())
const authType = ref<'password' | 'privateKey'>('password')
const credential = ref('')
const retryAuthType = ref<'password' | 'privateKey'>('password')
const retryCredential = ref('')
const importText = ref('')
const formError = ref('')
const retryError = ref('')
let disposed = false
let loadSequence = 0
let timer: ReturnType<typeof setTimeout> | undefined

function errorText(code?: string | null): string {
  const key = `onboarding.errors.${code}`
  return code && te(key) ? t(key) : t('onboarding.actionFailed')
}
function apiErrorText(error: unknown): string {
  return errorText(error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined)
}
const preview = computed(() => {
  try { return { nodes: parseHostOnboardingCsv(importText.value), error: '' } }
  catch (error) {
    return { nodes: [], error: error instanceof OnboardingCsvError
      ? (error.row ? t('onboarding.rowError', { row: error.row, error: errorText(error.code) }) : errorText(error.code))
      : errorText('CSV_INVALID') }
  }
})
const generatedName = computed(() => ('host-' + hostAddress.value.trim().toLowerCase().replace(/\.$/, '').replace(/[^a-z0-9_-]/g, '-')).slice(0, 64))
const inputNodes = computed<OnboardingTargetInput[]>(() => createMode.value === 'single' ? [{
  name: batchName.value.trim() || generatedName.value, address: hostAddress.value.trim(), sshPort: sshPort.value,
  sshFingerprint: sshFingerprint.value.trim() || undefined
}] : preview.value.nodes)
const importBlocked = computed(() => createMode.value === 'batch' && (!!preview.value.error || !preview.value.nodes.length))
const credentialsNeeded = computed(() => createMode.value === 'single' || preview.value.nodes.some(node => !node.password && !node.privateKey))
const statusClasses: Record<OnboardingStatus, string> = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  succeeded: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  failed: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
}
function counts(batch: OnboardingBatch) {
  return { total: batch.nodes.length, succeeded: batch.nodes.filter(node => node.status === 'succeeded').length,
    failed: batch.nodes.filter(node => node.status === 'failed').length,
    running: batch.nodes.filter(node => node.status === 'running' || node.status === 'queued').length }
}
function date(value: string): string { return new Date(value).toLocaleString(locale.value) }

async function loadBatches() {
  clearTimeout(timer)
  const sequence = ++loadSequence
  try {
    const result = await api.hostOnboarding.list({ page: page.value, search: search.value.trim() })
    if (disposed || sequence !== loadSequence) return
    batches.value = result.batches
    total.value = result.total
    gatewaySshHost.value = result.gatewaySshHost
    loadFailed.value = false
    if (!expanded.value) expanded.value = result.batches[0]?.id || null
  } catch {
    if (!disposed && sequence === loadSequence) loadFailed.value = true
  } finally {
    if (!disposed && sequence === loadSequence) {
      loading.value = false
      const active = batches.value.some(batch => batch.nodes.some(node => ['queued', 'running'].includes(node.status)))
      timer = setTimeout(() => void loadBatches(), active ? 5000 : 15000)
    }
  }
}
async function loadGateway() {
  try { const result = await api.hostOnboarding.gateway(); if (!disposed) gateway.value = result }
  catch { if (!disposed) gateway.value = { ready: false, code: 'GATEWAY_UNREACHABLE' } }
}
async function refresh() { await Promise.all([loadBatches(), loadGateway(), inventory.value?.refresh()]) }
function changePage(next: number) {
  if (next < 1 || next > pageCount.value) return
  page.value = next; expanded.value = null; void loadBatches()
}
function applySearch() { page.value = 1; expanded.value = null; void loadBatches() }
async function openCreate(mode: 'single' | 'batch') {
  createMode.value = mode; showCreate.value = true
  void api.hostOnboarding.inventory().then(result => {
    if (disposed) return
    machineSuggestions.value = [...new Set(['E2', 'ARM', ...result.machineGroups])]
    regionSuggestions.value = result.regionGroups
  }).catch(() => { /* Group suggestions are optional; custom values still work. */ })
  await nextTick()
  firstCreateInput.value?.focus()
}
function expandOptions(event: Event) { (event.currentTarget as HTMLDetailsElement).open = true }
function closeCreate() {
  if (submitting.value) return
  showCreate.value = false
  credential.value = ''; importText.value = ''; formError.value = ''
  batchName.value = ''; accountLabel.value = ''; requestId.value = crypto.randomUUID()
  hostAddress.value = ''; sshPort.value = 22; sshFingerprint.value = ''; authType.value = 'password'
  defaults.value = initialDefaults()
}
async function readCsv(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (file.size > 2 * 1024 * 1024) throw new OnboardingCsvError('CSV_TOO_LARGE')
    const text = await file.text()
    if (!disposed && showCreate.value) { importText.value = text; formError.value = '' }
  } catch { formError.value = errorText('CSV_TOO_LARGE') }
  finally { input.value = '' }
}
async function createHosts() {
  if (submitting.value || importBlocked.value || !gateway.value?.ready) return
  submitting.value = true; formError.value = ''
  try {
    const result = await api.hostOnboarding.create({ requestId: requestId.value, name: batchName.value.trim() || generatedName.value, accountLabel: accountLabel.value.trim(),
      defaults: { ...defaults.value }, credentials: credential.value ? { [authType.value]: credential.value } : {}, nodes: inputNodes.value })
    submitting.value = false
    closeCreate()
    if (disposed) return
    expanded.value = result.id; page.value = 1; search.value = ''
    activeTab.value = 'tasks'
    toast.success(t('onboarding.created'))
    await loadBatches()
  } catch (error) { formError.value = apiErrorText(error) }
  finally { submitting.value = false }
}
function openRetry(node: OnboardingNode) { retryNode.value = node; retryCredential.value = ''; retryError.value = '' }
function closeRetry() { if (!actionNodeId.value) { retryNode.value = null; retryCredential.value = ''; retryError.value = '' } }
async function retry() {
  if (!retryNode.value || actionNodeId.value) return
  actionNodeId.value = retryNode.value.id; retryError.value = ''
  try {
    const credentials: OnboardingCredentials = retryCredential.value ? { [retryAuthType.value]: retryCredential.value } : {}
    await api.hostOnboarding.retry(retryNode.value.id, credentials)
    retryCredential.value = ''; retryNode.value = null
    toast.success(t('onboarding.retried')); await loadBatches()
  } catch (error) { retryError.value = apiErrorText(error) }
  finally { actionNodeId.value = null }
}
async function cancel(node: OnboardingNode) {
  if (actionNodeId.value) return
  actionNodeId.value = node.id
  try { await api.hostOnboarding.cancel(node.id); toast.success(t('onboarding.cancelled')); await loadBatches() }
  catch (error) { toast.error(apiErrorText(error)) }
  finally { actionNodeId.value = null }
}
const controlCommand = computed(() => gatewaySshHost.value ? `ssh root@${gatewaySshHost.value}` : '')
const hostCommand = computed(() => sshNode.value?.managementIp
  ? `ssh -i /root/.ssh/incudal-host-management -p ${sshNode.value.sshPort} root@${sshNode.value.managementIp}` : '')
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); toast.success(t('common.copied')) }
  catch { toast.error(t('common.copyFailed')) }
}
onMounted(() => void refresh())
onUnmounted(() => { disposed = true; clearTimeout(timer); credential.value = ''; retryCredential.value = ''; importText.value = '' })
</script>

<template>
  <div class="space-y-4 animate-fade-in">
    <div class="page-header gap-3">
      <div class="min-w-0">
        <h1 class="page-title">{{ t('onboarding.title') }}</h1>
        <p class="page-description">{{ t('onboarding.description') }}</p>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        <button type="button" class="btn-primary whitespace-nowrap" :disabled="!gateway?.ready" @click="openCreate('single')">{{ t('onboarding.newHost') }}</button>
        <button type="button" class="btn-secondary whitespace-nowrap" :disabled="!gateway?.ready" @click="openCreate('batch')">{{ t('onboarding.importHosts') }}</button>
      </div>
    </div>

    <section class="card p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <p class="text-sm font-medium text-themed flex flex-wrap items-center gap-2">
          <span class="h-2 w-2 rounded-full shrink-0" :class="gateway?.ready ? 'bg-green-500' : 'bg-amber-500'"></span>
          {{ t(gateway?.ready ? 'onboarding.gatewayReady' : gateway ? 'onboarding.gatewayUnavailable' : 'common.loading') }}
        </p>
        <p class="mt-1 text-xs text-themed-muted">{{ gateway && !gateway.ready ? errorText(gateway.code) : t('onboarding.serverSide') }}</p>
      </div>
      <button type="button" class="btn-secondary shrink-0 self-start whitespace-nowrap" @click="refresh">{{ t('common.refresh') }}</button>
    </section>

    <div class="flex flex-wrap gap-2" role="tablist" :aria-label="t('onboarding.title')">
      <button type="button" role="tab" :aria-selected="activeTab === 'hosts'" :class="activeTab === 'hosts' ? 'btn-primary' : 'btn-secondary'" @click="activeTab = 'hosts'">{{ t('hostInventory.hostsTab') }}</button>
      <button type="button" role="tab" :aria-selected="activeTab === 'tasks'" :class="activeTab === 'tasks' ? 'btn-primary' : 'btn-secondary'" @click="activeTab = 'tasks'">{{ t('hostInventory.tasksTab') }}</button>
    </div>
    <HostInventoryPanel v-if="activeTab === 'hosts'" ref="inventory" />
    <div v-else class="space-y-4">
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="applySearch">
        <input v-model="search" type="search" class="input flex-1 min-w-0 sm:max-w-sm" maxlength="100" :aria-label="t('common.search')" :placeholder="t('onboarding.searchPlaceholder')" />
        <button class="btn-secondary whitespace-nowrap" type="submit">{{ t('common.search') }}</button>
        <span class="text-xs text-themed-muted">{{ t('onboarding.batchCount', { count: total }) }}</span>
      </form>
      <div v-if="loadFailed" class="card p-4 text-sm text-red-600 dark:text-red-400" role="alert">{{ t('onboarding.loadFailed') }}</div>
      <div v-if="loading" class="card p-8 text-sm text-themed-muted text-center">{{ t('common.loading') }}</div>
      <div v-else-if="!batches.length && !loadFailed" class="card p-8 text-center text-sm text-themed-muted">{{ t('onboarding.empty') }}</div>

      <section v-for="batch in batches" :key="batch.id" class="card overflow-hidden">
        <button type="button" class="w-full p-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-left" :aria-expanded="expanded === batch.id" @click="expanded = expanded === batch.id ? null : batch.id">
          <span class="min-w-0">
            <span class="block text-sm font-semibold text-themed break-words">{{ batch.name }}</span>
            <span class="block text-xs text-themed-muted mt-1 break-words"><template v-if="batch.accountLabel">{{ batch.accountLabel }} · </template>{{ date(batch.createdAt) }}</span>
          </span>
          <span class="text-xs text-themed-muted shrink-0">{{ t('onboarding.summary', counts(batch)) }} {{ expanded === batch.id ? '−' : '+' }}</span>
        </button>
        <div v-if="expanded === batch.id" class="border-t border-themed">
          <div class="px-4 py-2 text-xs text-themed-muted flex flex-wrap gap-x-4 gap-y-1 bg-themed-secondary">
            <span v-if="batch.defaults.machineGroup">{{ t('hostInventory.machineGroup') }}: {{ batch.defaults.machineGroup }}</span>
            <span v-if="batch.defaults.regionGroup">{{ t('hostInventory.regionGroup') }}: {{ batch.defaults.regionGroup }}</span>
            <span>{{ t('portProtocol.title') }}: {{ t(`portProtocol.${batch.defaults.portProtocol}`) }}</span>
            <span>{{ t('onboarding.cpu') }}: {{ batch.defaults.cpuAllowanceMax }}%</span>
            <span>{{ t('onboarding.memory') }}: {{ batch.defaults.memoryMax }} MB</span>
            <span>{{ t('onboarding.storage') }}: {{ batch.defaults.storageSize }} GiB</span>
          </div>
          <div class="divide-y divide-gray-100 dark:divide-gray-800">
            <article v-for="node in batch.nodes" :key="node.id" class="p-4 grid grid-cols-1 md:grid-cols-[minmax(10rem,1fr)_minmax(14rem,2fr)_auto] gap-3 md:items-center">
              <div class="min-w-0">
                <RouterLink v-if="node.hostId" :to="`/resources/hosts/${node.hostId}`" class="text-sm font-medium text-blue-600 dark:text-blue-400 break-all">{{ node.name }}</RouterLink>
                <span v-else class="text-sm font-medium text-themed break-all">{{ node.name }}</span>
                <p class="text-xs text-themed-muted font-mono mt-1">{{ node.publicIp }}:{{ node.sshPort }}</p>
                <p v-if="node.managementIp" class="text-xs text-themed-muted mt-1">{{ t('onboarding.managementIp') }}: {{ node.managementIp }}</p>
                <p v-if="node.machineGroup || node.regionGroup" class="text-xs text-themed-muted mt-1 break-words">{{ node.machineGroup || batch.defaults.machineGroup }} · {{ node.regionGroup || batch.defaults.regionGroup }}</p>
              </div>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="px-2 py-1 rounded" :class="statusClasses[node.status]">{{ t(`onboarding.status.${node.status}`) }}</span>
                  <span v-if="node.status !== 'succeeded' && node.status !== 'cancelled'" class="text-themed-muted">{{ t(`onboarding.steps.${node.step}`) }}</span>
                  <span v-if="node.attempt > 0" class="text-themed-muted">{{ t('onboarding.attempt', { count: node.attempt }) }}</span>
                </div>
                <p v-if="node.errorCode" class="text-xs text-red-600 dark:text-red-400 mt-2 break-words">{{ errorText(node.errorCode) }}</p>
                <p v-if="node.status === 'succeeded' && node.host" class="text-xs text-themed-muted mt-2">{{ node.host.architecture }} · {{ t(`onboarding.hostStatus.${node.host.status}`) }}</p>
              </div>
              <div class="flex flex-wrap gap-2 md:justify-end">
                <button v-if="node.managementIp" type="button" class="btn-secondary text-xs whitespace-nowrap" @click="sshNode = node">SSH</button>
                <button v-if="node.status === 'failed' || node.status === 'cancelled'" type="button" class="btn-secondary text-xs whitespace-nowrap" :disabled="!!actionNodeId || !gateway?.ready" @click="openRetry(node)">{{ t('common.retry') }}</button>
                <button v-if="node.status === 'queued' || node.status === 'failed'" type="button" class="btn-secondary text-xs whitespace-nowrap" :disabled="!!actionNodeId" @click="cancel(node)">{{ t('common.cancel') }}</button>
              </div>
            </article>
          </div>
        </div>
      </section>
      <div v-if="total > 10" class="flex items-center justify-end gap-3">
        <button class="btn-secondary" :disabled="page <= 1" @click="changePage(page - 1)">{{ t('common.prevPage') }}</button>
        <span class="text-sm text-themed-muted">{{ page }} / {{ pageCount }}</span>
        <button class="btn-secondary" :disabled="page >= pageCount" @click="changePage(page + 1)">{{ t('common.nextPage') }}</button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="showCreate" class="modal-overlay" @keydown.esc="closeCreate">
        <div class="modal-backdrop" @click="closeCreate"></div>
        <form class="modal-content onboarding-create-dialog max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-create-title" @submit.prevent="createHosts">
          <div class="modal-header gap-2">
            <h2 id="onboarding-create-title" class="modal-title">{{ t(createMode === 'single' ? 'onboarding.newHost' : 'onboarding.importHosts') }}</h2>
            <button type="button" class="btn-secondary" :disabled="submitting" @click="closeCreate">{{ t('common.close') }}</button>
          </div>
          <div class="modal-body min-h-0 overflow-y-auto">
            <fieldset class="space-y-4 min-w-0" :disabled="submitting">
              <template v-if="createMode === 'single'">
                <p class="text-sm text-themed-muted">{{ t('onboarding.singleHint') }}</p>
                <div class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_8rem] gap-3">
                  <label class="text-sm text-themed min-w-0">{{ t('onboarding.address') }}<input ref="firstCreateInput" v-model.trim="hostAddress" required maxlength="254" class="input w-full mt-1" autocomplete="off" autocapitalize="none" spellcheck="false" :placeholder="t('onboarding.addressPlaceholder')" /></label>
                  <label class="text-sm text-themed">{{ t('onboarding.sshPort') }}<input v-model.number="sshPort" required type="number" min="1" max="65535" step="1" class="input w-full mt-1" /></label>
                </div>
              </template>
              <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="text-sm text-themed">{{ t('onboarding.batchName') }}<input ref="firstCreateInput" v-model="batchName" required maxlength="80" class="input w-full mt-1" autocomplete="off" /></label>
                <label class="text-sm text-themed">{{ t('onboarding.accountLabel') }}<input v-model="accountLabel" required maxlength="80" class="input w-full mt-1" autocomplete="off" /></label>
              </div>
              <div class="space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <label for="onboarding-credential" class="text-sm text-themed">{{ t(authType === 'password' ? 'onboarding.password' : 'onboarding.privateKey') }}</label>
                  <button type="button" class="text-xs text-primary-600 dark:text-primary-400 hover:underline" @click="authType = authType === 'password' ? 'privateKey' : 'password'; credential = ''">{{ t(authType === 'password' ? 'onboarding.usePrivateKey' : 'onboarding.usePassword') }}</button>
                </div>
                <input v-if="authType === 'password'" id="onboarding-credential" v-model="credential" type="password" autocomplete="new-password" maxlength="1024" :required="credentialsNeeded" class="input w-full" />
                <textarea v-else id="onboarding-credential" v-model="credential" autocomplete="off" spellcheck="false" maxlength="32768" :required="credentialsNeeded" rows="4" class="input w-full font-mono text-xs"></textarea>
                <p class="text-xs text-themed-muted">{{ t(createMode === 'single' ? 'onboarding.singleCredentialsHint' : 'onboarding.credentialsHint') }}</p>
              </div>
              <details :open="createMode === 'batch'" class="rounded-lg border border-themed" @invalid.capture="expandOptions">
                <summary class="cursor-pointer p-3 text-sm font-medium text-themed">{{ t('onboarding.optionalSettings') }}</summary>
                <div class="px-3 pb-3 space-y-3">
                  <div v-if="createMode === 'single'" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="text-sm text-themed min-w-0">{{ t('onboarding.hostName') }}<input v-model.trim="batchName" maxlength="64" pattern="[A-Za-z0-9_\-]{2,64}" :title="t('onboarding.errors.HOST_NAME_INVALID')" :placeholder="hostAddress ? generatedName : t('onboarding.autoName')" class="input w-full mt-1" autocomplete="off" /></label>
                    <label class="text-sm text-themed">{{ t('onboarding.accountLabel') }}<input v-model.trim="accountLabel" maxlength="80" class="input w-full mt-1" autocomplete="off" /></label>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="text-sm text-themed">{{ t('hostInventory.machineGroup') }}<input v-model.trim="defaults.machineGroup" maxlength="60" list="onboarding-machine-groups" class="input w-full mt-1" :placeholder="t('hostInventory.machineHint')" /></label>
                    <label class="text-sm text-themed">{{ t('hostInventory.regionGroup') }}<input v-model.trim="defaults.regionGroup" maxlength="60" list="onboarding-region-groups" class="input w-full mt-1" :placeholder="t('hostInventory.regionHint')" /></label>
                    <datalist id="onboarding-machine-groups"><option v-for="group in machineSuggestions" :key="group" :value="group" /></datalist>
                    <datalist id="onboarding-region-groups"><option v-for="group in regionSuggestions" :key="group" :value="group" /></datalist>
                    <label class="text-sm text-themed">{{ t('onboarding.country') }}<select v-model="defaults.countryCode" class="input w-full mt-1"><option v-for="code in availableFlagCountryCodes" :key="code" :value="code">{{ getLocalizedCountryName(code, locale) }}</option></select></label>
                    <label class="text-sm text-themed">{{ t('portProtocol.title') }}<select v-model="defaults.portProtocol" class="input w-full mt-1"><option value="tcp">{{ t('portProtocol.tcp') }}</option><option value="tcp_udp">{{ t('portProtocol.tcp_udp') }}</option></select></label>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label class="text-sm text-themed">{{ t('onboarding.cpu') }} (%)<input v-model.number="defaults.cpuAllowanceMax" required type="number" min="1" max="100000" step="1" class="input w-full mt-1" /></label>
                    <label class="text-sm text-themed">{{ t('onboarding.memory') }} (MB)<input v-model.number="defaults.memoryMax" required type="number" min="256" max="1048576" step="1" class="input w-full mt-1" /></label>
                    <label class="text-sm text-themed">{{ t('onboarding.storage') }} (GiB)<input v-model.number="defaults.storageSize" required type="number" min="10" max="10000" step="1" class="input w-full mt-1" /></label>
                  </div>
                  <p class="text-xs text-themed-muted">{{ t('onboarding.resourceHint') }}</p>
                  <label v-if="createMode === 'single'" class="block text-sm text-themed">{{ t('onboarding.optionalFingerprint') }}<input v-model.trim="sshFingerprint" maxlength="50" pattern="SHA256:[A-Za-z0-9+\/]{43}" :title="t('onboarding.errors.SSH_FINGERPRINT_INVALID')" class="input w-full mt-1 font-mono text-xs" autocomplete="off" spellcheck="false" /></label>
                </div>
              </details>
              <div v-if="createMode === 'batch'" class="border-t border-themed pt-4 space-y-2">
                <label class="block text-sm text-themed">{{ t('onboarding.importFile') }}<input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" class="block w-full text-xs mt-2" @change="readCsv" /></label>
                <label class="block text-sm text-themed">{{ t('onboarding.machineList') }}<textarea v-model="importText" required rows="5" maxlength="2097152" autocomplete="off" spellcheck="false" class="input w-full mt-1 font-mono text-xs" :placeholder="t('onboarding.csvPlaceholder')"></textarea></label>
                <p class="text-xs text-themed-muted break-words">{{ t('onboarding.csvHint') }}</p>
                <p v-if="preview.error" class="text-xs text-red-600 dark:text-red-400" role="alert">{{ preview.error }}</p>
                <div v-if="preview.nodes.length" class="rounded border border-themed max-h-40 overflow-y-auto">
                  <div v-for="node in preview.nodes" :key="node.publicIp" class="px-3 py-2 text-xs text-themed flex flex-wrap gap-x-3 gap-y-1">
                    <span class="font-medium break-all">{{ node.name }}</span><span class="font-mono">{{ node.publicIp }}:{{ node.sshPort }}</span><span v-if="node.machineGroup || node.regionGroup" class="text-themed-muted">{{ node.machineGroup || defaults.machineGroup }} · {{ node.regionGroup || defaults.regionGroup }}</span><span class="text-themed-muted">{{ t(node.password || node.privateKey ? 'onboarding.rowCredentials' : 'onboarding.sharedCredentials') }}</span>
                  </div>
                </div>
                <p class="text-xs text-themed-muted">{{ t('onboarding.preflightHint') }}</p>
              </div>
              <p v-if="formError" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ formError }}</p>
            </fieldset>
          </div>
          <div class="modal-footer flex-wrap gap-2">
            <span class="text-xs text-themed-muted mr-auto">{{ t('onboarding.nodeCount', { count: createMode === 'single' ? 1 : preview.nodes.length }) }}</span>
            <button type="button" class="btn-secondary" :disabled="submitting" @click="closeCreate">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn-primary whitespace-nowrap" :disabled="submitting || importBlocked || !gateway?.ready">{{ t(submitting ? 'common.submitting' : 'onboarding.start') }}</button>
          </div>
        </form>
      </div>

      <div v-if="retryNode" class="modal-overlay" @keydown.esc="closeRetry">
        <div class="modal-backdrop" @click="closeRetry"></div>
        <form class="modal-content max-w-lg max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-retry-title" @submit.prevent="retry">
          <div class="modal-header"><h2 id="onboarding-retry-title" class="modal-title break-all">{{ t('onboarding.retryTitle', { name: retryNode.name }) }}</h2></div>
          <div class="modal-body min-h-0 overflow-y-auto">
            <fieldset class="space-y-3 min-w-0" :disabled="!!actionNodeId">
              <p class="text-xs text-themed-muted">{{ t('onboarding.retryHint') }}</p>
              <label class="block text-sm text-themed">{{ t('onboarding.authType') }}<select v-model="retryAuthType" class="input w-full mt-1"><option value="password">{{ t('onboarding.password') }}</option><option value="privateKey">{{ t('onboarding.privateKey') }}</option></select></label>
              <label class="block text-sm text-themed">{{ t(retryAuthType === 'password' ? 'onboarding.password' : 'onboarding.privateKey') }}
                <input v-if="retryAuthType === 'password'" v-model="retryCredential" type="password" autocomplete="new-password" maxlength="1024" :required="retryNode.status === 'cancelled'" class="input w-full mt-1" />
                <textarea v-else v-model="retryCredential" rows="5" autocomplete="off" spellcheck="false" maxlength="32768" :required="retryNode.status === 'cancelled'" class="input w-full mt-1 font-mono text-xs"></textarea>
              </label>
              <p v-if="retryError" class="text-sm text-red-600 dark:text-red-400" role="alert">{{ retryError }}</p>
            </fieldset>
          </div>
          <div class="modal-footer gap-2"><button type="button" class="btn-secondary" :disabled="!!actionNodeId" @click="closeRetry">{{ t('common.cancel') }}</button><button type="submit" class="btn-primary" :disabled="!!actionNodeId">{{ t('common.retry') }}</button></div>
        </form>
      </div>

      <div v-if="sshNode" class="modal-overlay" @keydown.esc="sshNode = null">
        <div class="modal-backdrop" @click="sshNode = null"></div>
        <section class="modal-content max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-ssh-title">
          <div class="modal-header"><h2 id="onboarding-ssh-title" class="modal-title">{{ t('onboarding.sshTitle') }}</h2></div>
          <div class="modal-body space-y-4 overflow-y-auto">
            <p class="text-sm text-themed break-all">{{ sshNode.name }} · {{ sshNode.publicIp }} → {{ sshNode.managementIp }}</p>
            <div v-if="controlCommand"><p class="text-sm text-themed mb-2">{{ t('onboarding.sshControl') }}</p><pre class="p-3 rounded bg-themed-secondary text-themed text-xs overflow-x-auto">{{ controlCommand }}</pre><button class="btn-secondary text-xs mt-2" @click="copy(controlCommand)">{{ t('common.copy') }}</button></div>
            <div><p class="text-sm text-themed mb-2">{{ t('onboarding.sshHost') }}</p><pre class="p-3 rounded bg-themed-secondary text-themed text-xs overflow-x-auto">{{ hostCommand }}</pre><button class="btn-secondary text-xs mt-2" @click="copy(hostCommand)">{{ t('common.copy') }}</button></div>
            <p class="text-xs text-themed-muted">{{ t('onboarding.sshHint') }}</p>
            <p v-if="sshNode.sshFingerprint" class="text-xs text-themed-muted break-all">{{ t('onboarding.fingerprint') }}: <span class="font-mono">{{ sshNode.sshFingerprint }}</span></p>
          </div>
          <div class="modal-footer"><button class="btn-secondary" @click="sshNode = null">{{ t('common.close') }}</button></div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-content { max-height: 90dvh; overflow: hidden; }
.onboarding-create-dialog { max-width: 48rem; }
.modal-header, .modal-footer { flex-shrink: 0; }
.modal-body { min-height: 0; overflow-y: auto; }
</style>
