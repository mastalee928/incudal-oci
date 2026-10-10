<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useToast } from '@/stores/toast'
import HostPortProtocolSetting from '@/components/host/HostPortProtocolSetting.vue'
import PortProtocolBadge from '@/components/instance/PortProtocolBadge.vue'
import type { ManagedHost, UpdateHostGroupsRequest } from '@/types/api'

const { t, te } = useI18n()
const toast = useToast()
const hosts = ref<ManagedHost[]>([])
const total = ref(0)
const page = ref(1)
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
const search = ref('')
const machineGroup = ref('')
const regionGroup = ref('')
const machineGroups = ref<string[]>([])
const regionGroups = ref<string[]>([])
const machineSuggestions = computed(() => [...new Set(['E2', 'ARM', ...machineGroups.value])])
const loading = ref(true)
const failed = ref(false)
const selected = ref<number[]>([])
const allSelected = computed({
  get: () => hosts.value.length > 0 && hosts.value.every(host => selected.value.includes(host.id)),
  set: (value: boolean) => { selected.value = value ? hosts.value.map(host => host.id) : [] }
})
const groupTargets = ref<ManagedHost[]>([])
const machineAction = ref<'keep' | 'set' | 'clear'>('keep')
const regionAction = ref<'keep' | 'set' | 'clear'>('keep')
const newMachineGroup = ref('')
const newRegionGroup = ref('')
const saving = ref(false)
const protocolHost = ref<ManagedHost | null>(null)
let disposed = false
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined

async function refresh() {
  clearTimeout(timer)
  const current = ++sequence
  try {
    const result = await api.hostOnboarding.inventory({ page: page.value, search: search.value.trim(), machineGroup: machineGroup.value, regionGroup: regionGroup.value })
    if (disposed || current !== sequence) return
    hosts.value = result.hosts; total.value = result.total
    machineGroups.value = result.machineGroups; regionGroups.value = result.regionGroups
    selected.value = selected.value.filter(id => result.hosts.some(host => host.id === id))
    failed.value = false
    if (page.value > pages.value) { page.value = pages.value; void refresh() }
  } catch { if (!disposed && current === sequence) failed.value = true }
  finally {
    if (!disposed && current === sequence) { loading.value = false; timer = setTimeout(() => void refresh(), 15000) }
  }
}
function filter() { page.value = 1; selected.value = []; void refresh() }
function changePage(value: number) { page.value = value; selected.value = []; void refresh() }
function openGroups(targets: ManagedHost[]) {
  groupTargets.value = targets
  machineAction.value = targets.length === 1 && targets[0].machineGroup ? 'set' : 'keep'
  regionAction.value = targets.length === 1 && targets[0].regionGroup ? 'set' : 'keep'
  newMachineGroup.value = targets.length === 1 ? targets[0].machineGroup || '' : ''
  newRegionGroup.value = targets.length === 1 ? targets[0].regionGroup || '' : ''
}
function closeGroups() { if (!saving.value) groupTargets.value = [] }
async function saveGroups() {
  if (saving.value) return
  const data: UpdateHostGroupsRequest = { hostIds: groupTargets.value.map(host => host.id) }
  if (machineAction.value !== 'keep') data.machineGroup = machineAction.value === 'clear' ? null : newMachineGroup.value.trim()
  if (regionAction.value !== 'keep') data.regionGroup = regionAction.value === 'clear' ? null : newRegionGroup.value.trim()
  saving.value = true
  try {
    await api.hostOnboarding.updateGroups(data)
    groupTargets.value = []; selected.value = []
    toast.success(t('hostInventory.groupsSaved'))
    await refresh()
  } catch { toast.error(t('hostInventory.groupsFailed')) }
  finally { saving.value = false }
}
function closeProtocol() { protocolHost.value = null; void refresh() }
function status(host: ManagedHost) { return te(`onboarding.hostStatus.${host.status}`) ? t(`onboarding.hostStatus.${host.status}`) : host.status }
onMounted(() => void refresh())
onUnmounted(() => { disposed = true; clearTimeout(timer) })
defineExpose({ refresh })
</script>

<template>
  <section class="space-y-4">
    <form class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_12rem_14rem_auto] gap-2" @submit.prevent="filter">
      <input v-model="search" type="search" class="input w-full min-w-0" maxlength="100" :aria-label="t('common.search')" :placeholder="t('hostInventory.search')" />
      <select v-model="machineGroup" class="input w-full min-w-0" :aria-label="t('hostInventory.machineGroup')" @change="filter"><option value="">{{ t('hostInventory.allMachines') }}</option><option v-for="group in machineGroups" :key="group" :value="group">{{ group }}</option></select>
      <select v-model="regionGroup" class="input w-full min-w-0" :aria-label="t('hostInventory.regionGroup')" @change="filter"><option value="">{{ t('hostInventory.allRegions') }}</option><option v-for="group in regionGroups" :key="group" :value="group">{{ group }}</option></select>
      <button class="btn-secondary whitespace-nowrap" type="submit">{{ t('common.search') }}</button>
    </form>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-2 text-sm text-themed"><input v-model="allSelected" type="checkbox" :disabled="!hosts.length" />{{ t('hostInventory.selectPage') }}</label>
        <button type="button" class="btn-secondary text-xs whitespace-nowrap" :disabled="!selected.length" @click="openGroups(hosts.filter(host => selected.includes(host.id)))">{{ t('hostInventory.batchGroups', { count: selected.length }) }}</button>
      </div>
      <span class="text-xs text-themed-muted">{{ t('hostInventory.total', { count: total }) }}</span>
    </div>
    <p v-if="failed" class="card p-4 text-sm text-red-600 dark:text-red-400" role="alert">{{ t('hostInventory.loadFailed') }}</p>
    <div v-if="loading" class="card p-8 text-sm text-themed-muted text-center">{{ t('common.loading') }}</div>
    <div v-else-if="!hosts.length && !failed" class="card p-8 text-sm text-themed-muted text-center">{{ t('hostInventory.empty') }}</div>
    <div v-if="hosts.length" class="card divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
      <article v-for="host in hosts" :key="host.id" class="p-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-3 xl:grid-cols-[auto_minmax(13rem,1.4fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_auto] xl:items-center">
        <input v-model="selected" type="checkbox" :value="host.id" class="mt-1 xl:mt-0" :aria-label="t('hostInventory.selectHost', { name: host.name })" />
        <div class="min-w-0">
          <RouterLink :to="`/resources/hosts/${host.id}`" class="text-sm font-semibold text-blue-600 dark:text-blue-400 break-all">{{ host.name }}</RouterLink>
          <span class="ml-2 text-xs text-themed-muted">#{{ host.id }}</span>
          <dl class="mt-2 text-xs space-y-1">
            <div class="flex flex-wrap gap-x-2"><dt class="text-themed-muted">{{ t('hostInventory.publicIp') }}</dt><dd class="font-mono text-themed break-all">{{ host.publicIp || '—' }}</dd></div>
            <div class="flex flex-wrap gap-x-2"><dt class="text-themed-muted">{{ t('hostInventory.managementIp') }}</dt><dd class="font-mono text-themed break-all">{{ host.managementAddress || '—' }}</dd></div>
          </dl>
        </div>
        <div class="col-start-2 xl:col-start-auto min-w-0">
          <div class="flex flex-wrap gap-1.5 text-xs">
            <span class="px-2 py-1 rounded bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 break-all">{{ host.machineGroup || t('hostInventory.machineUnset') }}</span>
            <span class="px-2 py-1 rounded bg-themed-secondary text-themed break-all">{{ host.regionGroup || t('hostInventory.regionUnset') }}</span>
          </div>
          <p v-if="host.accountLabel" class="text-xs text-themed-muted mt-2 break-words">{{ t('onboarding.accountLabel') }}: {{ host.accountLabel }}</p>
        </div>
        <div class="col-start-2 xl:col-start-auto min-w-0 space-y-2">
          <p class="flex flex-wrap items-center gap-2 text-xs"><span class="h-2 w-2 rounded-full" :class="host.status === 'online' ? 'bg-green-500' : 'bg-gray-400'"></span><span class="text-themed">{{ status(host) }}</span><span class="text-themed-muted">{{ host.architecture }}</span></p>
          <PortProtocolBadge :value="host.portProtocol" />
          <p class="text-xs text-themed-muted">{{ t('hostInventory.instances', { count: host.instanceCount }) }}</p>
        </div>
        <div class="col-start-2 xl:col-start-auto flex flex-wrap gap-2 xl:max-w-48 xl:justify-end">
          <RouterLink :to="`/resources/hosts/${host.id}`" class="btn-primary text-xs whitespace-nowrap">{{ t('hostInventory.manage') }}</RouterLink>
          <button type="button" class="btn-secondary text-xs whitespace-nowrap" @click="openGroups([host])">{{ t('hostInventory.groups') }}</button>
          <button type="button" class="btn-secondary text-xs whitespace-nowrap" @click="protocolHost = host">{{ t('hostInventory.protocol') }}</button>
        </div>
      </article>
    </div>
    <div v-if="pages > 1" class="flex flex-wrap items-center justify-end gap-3">
      <button class="btn-secondary" :disabled="page <= 1" @click="changePage(page - 1)">{{ t('common.prevPage') }}</button><span class="text-sm text-themed-muted">{{ page }} / {{ pages }}</span><button class="btn-secondary" :disabled="page >= pages" @click="changePage(page + 1)">{{ t('common.nextPage') }}</button>
    </div>

    <Teleport to="body">
      <div v-if="groupTargets.length" class="modal-overlay" @keydown.esc="closeGroups">
        <div class="modal-backdrop" @click="closeGroups"></div>
        <form class="modal-content max-w-xl max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="host-groups-title" @submit.prevent="saveGroups">
          <div class="modal-header"><h2 id="host-groups-title" class="modal-title">{{ t('hostInventory.editGroups') }}</h2></div>
          <div class="modal-body min-h-0 overflow-y-auto">
            <fieldset class="space-y-4 min-w-0" :disabled="saving">
              <p class="text-sm text-themed break-words">{{ groupTargets.length === 1 ? `${groupTargets[0].name} · ${groupTargets[0].publicIp || groupTargets[0].managementAddress}` : t('hostInventory.selectedCount', { count: groupTargets.length }) }}</p>
              <div>
                <label class="block text-sm text-themed" for="host-machine-action">{{ t('hostInventory.machineGroup') }}</label>
                <select id="host-machine-action" v-model="machineAction" class="input w-full mt-1"><option value="keep">{{ t('hostInventory.keepGroup') }}</option><option value="set">{{ t('hostInventory.setGroup') }}</option><option value="clear">{{ t('hostInventory.clearGroup') }}</option></select>
                <input v-if="machineAction === 'set'" v-model="newMachineGroup" required maxlength="60" list="host-machine-suggestions" class="input w-full mt-2" :aria-label="t('hostInventory.machineGroup')" :placeholder="t('hostInventory.machineHint')" />
                <datalist id="host-machine-suggestions"><option v-for="group in machineSuggestions" :key="group" :value="group" /></datalist>
              </div>
              <div>
                <label class="block text-sm text-themed" for="host-region-action">{{ t('hostInventory.regionGroup') }}</label>
                <select id="host-region-action" v-model="regionAction" class="input w-full mt-1"><option value="keep">{{ t('hostInventory.keepGroup') }}</option><option value="set">{{ t('hostInventory.setGroup') }}</option><option value="clear">{{ t('hostInventory.clearGroup') }}</option></select>
                <input v-if="regionAction === 'set'" v-model="newRegionGroup" required maxlength="60" list="host-region-suggestions" class="input w-full mt-2" :aria-label="t('hostInventory.regionGroup')" :placeholder="t('hostInventory.regionHint')" />
                <datalist id="host-region-suggestions"><option v-for="group in regionGroups" :key="group" :value="group" /></datalist>
              </div>
            </fieldset>
          </div>
          <div class="modal-footer gap-2"><button type="button" class="btn-secondary" :disabled="saving" @click="closeGroups">{{ t('common.cancel') }}</button><button class="btn-primary" type="submit" :disabled="saving || (machineAction === 'keep' && regionAction === 'keep')">{{ t(saving ? 'common.saving' : 'common.save') }}</button></div>
        </form>
      </div>
      <div v-if="protocolHost" class="modal-overlay" @keydown.esc="closeProtocol">
        <div class="modal-backdrop" @click="closeProtocol"></div>
        <section class="modal-content max-w-xl max-h-[90dvh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="inventory-protocol-title">
          <div class="modal-header"><h2 id="inventory-protocol-title" class="modal-title break-all">{{ protocolHost.name }}</h2></div>
          <div class="modal-body overflow-y-auto"><p class="text-xs text-themed-muted mb-4">{{ t('hostInventory.publicIp') }}: {{ protocolHost.publicIp || '—' }}</p><HostPortProtocolSetting :host-id="protocolHost.id" /></div>
          <div class="modal-footer"><button class="btn-secondary" @click="closeProtocol">{{ t('common.close') }}</button></div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.modal-content { max-width: 36rem; max-height: 90dvh; overflow: hidden; }
.modal-header, .modal-footer { flex-shrink: 0; }
.modal-body { min-height: 0; overflow-y: auto; }
</style>
