import type { Prisma } from '@prisma/client'
import { OnboardingError, validHostGroup } from '../lib/host-onboarding.js'

export interface HostGroupInput {
  machineGroupId?: number | null
  regionGroupId?: number | null
  machineGroup?: string | null
  regionGroup?: string | null
}
export interface HostGroupAssignment {
  machineGroupId: number | null
  regionGroupId: number | null
  machineGroup: string | null
  regionGroup: string | null
}

const empty: HostGroupAssignment = { machineGroupId: null, regionGroupId: null, machineGroup: null, regionGroup: null }

// Serialize group edits with assignments, including hosts created by the worker.
export async function lockHostGroups(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(734821, 1)`
}

function groupName(value: string): string {
  if (!validHostGroup(value)) throw new OnboardingError('HOST_GROUP_INVALID')
  return value.trim()
}

/** IDs are authoritative; names remain supported for existing CSV imports and API clients. */
export async function resolveHostGroups(tx: Prisma.TransactionClient, input: HostGroupInput, previous: HostGroupAssignment = empty): Promise<HostGroupAssignment> {
  await lockHostGroups(tx)
  const machineChanged = input.machineGroupId !== undefined || input.machineGroup !== undefined
  if (input.machineGroupId === null || (input.machineGroupId === undefined && (input.machineGroup === null || input.machineGroup === ''))) return { ...empty }
  let machine = null
  if (input.machineGroupId !== undefined) {
    machine = await tx.hostMachineGroup.findUnique({ where: { id: input.machineGroupId } })
    if (!machine) throw new OnboardingError('HOST_GROUP_NOT_FOUND')
  } else if (input.machineGroup !== undefined && input.machineGroup !== null && input.machineGroup !== '') {
    const name = groupName(input.machineGroup)
    machine = await tx.hostMachineGroup.upsert({ where: { name }, create: { name }, update: {} })
  } else if (previous.machineGroupId) {
    machine = await tx.hostMachineGroup.findUnique({ where: { id: previous.machineGroupId } })
  } else if (previous.machineGroup) {
    const name = groupName(previous.machineGroup)
    machine = await tx.hostMachineGroup.upsert({ where: { name }, create: { name }, update: {} })
  }

  let region = null
  if (input.regionGroupId !== undefined && input.regionGroupId !== null) {
    region = await tx.hostRegionGroup.findUnique({ where: { id: input.regionGroupId } })
    if (!region) throw new OnboardingError('HOST_GROUP_NOT_FOUND')
    if (machine && region.machineGroupId !== machine.id) throw new OnboardingError('HOST_GROUP_MISMATCH')
    if (!machine && !machineChanged) machine = await tx.hostMachineGroup.findUnique({ where: { id: region.machineGroupId } })
    if (!machine) throw new OnboardingError('HOST_GROUP_MISMATCH')
  } else if (input.regionGroupId === undefined && input.regionGroup !== undefined && input.regionGroup !== null && input.regionGroup !== '') {
    if (!machine) throw new OnboardingError('HOST_MACHINE_GROUP_REQUIRED')
    const name = groupName(input.regionGroup)
    region = await tx.hostRegionGroup.upsert({
      where: { machineGroupId_name: { machineGroupId: machine.id, name } },
      create: { machineGroupId: machine.id, name }, update: {}
    })
  } else if (input.regionGroupId === undefined && input.regionGroup === undefined && machine?.id === previous.machineGroupId && previous.regionGroupId) {
    region = await tx.hostRegionGroup.findUnique({ where: { id: previous.regionGroupId } })
  }
  return { machineGroupId: machine?.id || null, machineGroup: machine?.name || null, regionGroupId: region?.id || null, regionGroup: region?.name || null }
}

export async function renameMachineGroup(tx: Prisma.TransactionClient, id: number, value: string) {
  await lockHostGroups(tx)
  const name = groupName(value)
  const group = await tx.hostMachineGroup.update({ where: { id }, data: { name } })
  await tx.host.updateMany({ where: { machineGroupId: id }, data: { machineGroup: name } })
  await tx.hostOnboardingNode.updateMany({ where: { machineGroupId: id }, data: { machineGroup: name } })
  return group
}

export async function renameRegionGroup(tx: Prisma.TransactionClient, id: number, value: string, countryCode?: string | null) {
  await lockHostGroups(tx)
  const name = groupName(value)
  const group = await tx.hostRegionGroup.update({ where: { id }, data: { name, countryCode } })
  await tx.host.updateMany({ where: { regionGroupId: id }, data: { regionGroup: name } })
  await tx.hostOnboardingNode.updateMany({ where: { regionGroupId: id }, data: { regionGroup: name } })
  return group
}

export async function deleteMachineGroup(tx: Prisma.TransactionClient, id: number) {
  await lockHostGroups(tx)
  // Clear both levels atomically. Neither hosts nor customer instances are deleted.
  await tx.host.updateMany({ where: { machineGroupId: id }, data: empty })
  await tx.hostOnboardingNode.updateMany({ where: { machineGroupId: id }, data: empty })
  await tx.hostMachineGroup.delete({ where: { id } })
}

export async function deleteRegionGroup(tx: Prisma.TransactionClient, id: number) {
  await lockHostGroups(tx)
  const data = { regionGroupId: null, regionGroup: null }
  await tx.host.updateMany({ where: { regionGroupId: id }, data })
  await tx.hostOnboardingNode.updateMany({ where: { regionGroupId: id }, data })
  await tx.hostRegionGroup.delete({ where: { id } })
}
