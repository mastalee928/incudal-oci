<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useToast } from '@/stores/toast'
import { availableFlagCountryCodes, getLocalizedCountryName } from '@/utils/countryDisplay'
import { OnboardingCsvError, parseHostOnboardingCsv } from '@/utils/hostOnboardingCsv'
import HostInventoryPanel from '@/components/host/HostInventoryPanel.vue'
import type { OnboardingBatch, OnboardingCredentials, OnboardingDefaults, OnboardingGatewayStatus, OnboardingNode, OnboardingStatus } from '@/types/api'

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
const submitting = ref(false)
const actionNodeId = ref<string | null>(null)
const retryNode = ref<OnboardingNode | null>(null)
const sshNode = ref<OnboardingNode | null>(null)
const requestId = ref(crypto.randomUUID())
const batchName = ref('')
const accountLabel = ref('')
const defaults = ref<OnboardingDefaults>({ countryCode: 'us', storageSize: 30, cpuAllowanceMax: 200, memoryMax: 768, portProtocol: 'tcp_udp' })
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
const credentialsNeeded = computed(() => preview.value.nodes.some(node => !node.password && !node.privateKey))
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
function closeCreate() {
  if (submitting.value) return
  showCreate.value = false
  credential.value = ''; importText.value = ''; formError.value = ''
  batchName.value = ''; accountLabel.value = ''; requestId.value = crypto.randomUUID()
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
async function createBatch() {
  if (submitting.value || preview.value.error || !preview.value.nodes.length || !gateway.value?.ready) return
  submitting.value = true; formError.value = ''
  try {
    const result = await api.hostOnboarding.create({ requestId: requestId.value, name: batchName.value.trim(), accountLabel: accountLabel.value.trim(),
      defaults: { ...defaults.value }, credentials: credential.value ? { [authType.value]: credential.value } : {}, nodes: preview.value.nodes })
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
      <button type="button" class="btn-primary shrink-0 whitespace-nowrap" :disabled="!gateway?.ready" @click="showCreate = true">{{ t('onboarding.newBatch') }}</button>
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
            <span class="block text-xs text-themed-muted mt-1 break-words">{{ batch.accountLabel }} · {{ date(batch.createdAt) }}</span>
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
        <form class="modal-content onboarding-create-dialog max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-create-title" @submit.prevent="createBatch">
          <div class="modal-header gap-2">
            <h2 id="onboarding-create-title" class="modal-title">{{ t('onboarding.newBatch') }}</h2>
            <button type="button" class="btn-secondary" :disabled="submitting" @click="closeCreate">{{ t('common.close') }}</button>
          </div>
          <div class="modal-body min-h-0 overflow-y-auto">
            <fieldset class="space-y-4 min-w-0" :disabled="submitting">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label class="text-sm text-themed">{{ t('onboarding.batchName') }}<input v-model="batchName" required maxlength="80" class="input w-full mt-1" autocomplete="off" /></label>
                <label class="text-sm text-themed">{{ t('onboarding.accountLabel') }}<input v-model="accountLabel" required maxlength="80" class="input w-full mt-1" autocomplete="off" /></label>
                <label class="text-sm text-themed">{{ t('hostInventory.machineGroup') }}<input v-model="defaults.machineGroup" maxlength="60" list="onboarding-machine-groups" class="input w-full mt-1" :placeholder="t('hostInventory.machineHint')" /></label>
                <label class="text-sm text-themed">{{ t('hostInventory.regionGroup') }}<input v-model="defaults.regionGroup" maxlength="60" class="input w-full mt-1" :placeholder="t('hostInventory.regionHint')" /></label>
                <datalist id="onboarding-machine-groups"><option value="E2" /><option value="ARM" /></datalist>
                <label class="text-sm text-themed">{{ t('onboarding.country') }}<select v-model="defaults.countryCode" class="input w-full mt-1"><option v-for="code in availableFlagCountryCodes" :key="code" :value="code">{{ getLocalizedCountryName(code, locale) }}</option></select></label>
                <label class="text-sm text-themed">{{ t('portProtocol.title') }}<select v-model="defaults.portProtocol" class="input w-full mt-1"><option value="tcp">{{ t('portProtocol.tcp') }}</option><option value="tcp_udp">{{ t('portProtocol.tcp_udp') }}</option></select></label>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label class="text-sm text-themed">{{ t('onboarding.cpu') }} (%)<input v-model.number="defaults.cpuAllowanceMax" required type="number" min="1" max="100000" step="1" class="input w-full mt-1" /></label>
                <label class="text-sm text-themed">{{ t('onboarding.memory') }} (MB)<input v-model.number="defaults.memoryMax" required type="number" min="256" max="1048576" step="1" class="input w-full mt-1" /></label>
                <label class="text-sm text-themed">{{ t('onboarding.storage') }} (GiB)<input v-model.number="defaults.storageSize" required type="number" min="10" max="10000" step="1" class="input w-full mt-1" /></label>
              </div>
              <p class="text-xs text-themed-muted">{{ t('onboarding.resourceHint') }}</p>
              <div class="border-t border-themed pt-4 space-y-3">
                <label class="block text-sm text-themed">{{ t('onboarding.authType') }}<select v-model="authType" class="input w-full sm:w-48 mt-1 block"><option value="password">{{ t('onboarding.password') }}</option><option value="privateKey">{{ t('onboarding.privateKey') }}</option></select></label>
                <label class="block text-sm text-themed">{{ t(authType === 'password' ? 'onboarding.password' : 'onboarding.privateKey') }}
                  <input v-if="authType === 'password'" v-model="credential" type="password" autocomplete="new-password" maxlength="1024" :required="credentialsNeeded" class="input w-full mt-1" />
                  <textarea v-else v-model="credential" autocomplete="off" spellcheck="false" maxlength="32768" :required="credentialsNeeded" rows="4" class="input w-full mt-1 font-mono text-xs"></textarea>
                </label>
                <p class="text-xs text-themed-muted">{{ t('onboarding.credentialsHint') }}</p>
              </div>
              <div class="border-t border-themed pt-4 space-y-2">
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
            <span class="text-xs text-themed-muted mr-auto">{{ t('onboarding.nodeCount', { count: preview.nodes.length }) }}</span>
            <button type="button" class="btn-secondary" :disabled="submitting" @click="closeCreate">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn-primary whitespace-nowrap" :disabled="submitting || !!preview.error || !preview.nodes.length || !gateway?.ready">{{ t(submitting ? 'common.submitting' : 'onboarding.start') }}</button>
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
