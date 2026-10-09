import { prisma } from '../db/prisma.js'

export const PORT_PROTOCOL_CAPABILITY = 'ingress-port-protocol-v1'
export const portProtocolSelect = {
  portProtocol: true,
  portProtocolRevision: true,
  portProtocolApplied: true,
  portProtocolAppliedRevision: true,
  portProtocolError: true
} as const

export type PortProtocol = 'tcp' | 'tcp_udp'
type ProtocolRecord = {
  portProtocol: string
  portProtocolRevision: number
  portProtocolApplied: string
  portProtocolAppliedRevision: number
  portProtocolError: string | null
}

export function portProtocolView(host: ProtocolRecord) {
  return {
    requested: host.portProtocol as PortProtocol,
    applied: host.portProtocolApplied as PortProtocol,
    status: host.portProtocolError ? 'failed' as const : host.portProtocolAppliedRevision === host.portProtocolRevision
      ? 'applied' as const : 'pending' as const
  }
}

export async function getInstancePortProtocols(instanceIds: number[]) {
  const rows = await prisma.instance.findMany({ where: { id: { in: instanceIds } }, select: {
    id: true, host: { select: portProtocolSelect }
  } })
  return new Map(rows.map(row => [row.id, portProtocolView(row.host)]))
}

export async function permitsUdpMapping(hostId: number): Promise<boolean> {
  const host = await prisma.host.findUnique({ where: { id: hostId }, select: portProtocolSelect })
  return Boolean(host && host.portProtocol === 'tcp_udp' && host.portProtocolApplied === 'tcp_udp' && portProtocolView(host).status === 'applied')
}

export async function acceptPortProtocolReport(hostId: number, value: unknown) {
  if (!value || typeof value !== 'object') return
  const report = value as Record<string, unknown>
  if (typeof report.mode !== 'string' || !['tcp', 'tcp_udp'].includes(report.mode) || !Number.isSafeInteger(report.revision) || Number(report.revision) < 1 || Number(report.revision) > 2147483647 || typeof report.applied !== 'boolean') return
  // A delayed acknowledgement must never overwrite a newer operator choice.
  await prisma.host.updateMany({
    where: { id: hostId, portProtocol: String(report.mode), portProtocolRevision: Number(report.revision) },
    data: report.applied === true ? {
      portProtocolApplied: String(report.mode),
      portProtocolAppliedRevision: Number(report.revision),
      portProtocolError: null
    } : {
      portProtocolError: 'Agent could not apply the ingress protocol rule; check the host Agent log.'
    }
  })
}
