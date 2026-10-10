import { isIPv4 } from 'net'
import { Resolver } from 'node:dns/promises'
import { domainToASCII } from 'node:url'

export class OnboardingError extends Error {
  constructor(public readonly code: string) { super(code) }
}

export interface OnboardingDefaults {
  countryCode: string
  machineGroup?: string
  regionGroup?: string
  storageSize: number
  cpuAllowanceMax: number
  memoryMax: number
  portProtocol: 'tcp' | 'tcp_udp'
}
export interface OnboardingCredentials { password?: string; privateKey?: string }
export interface OnboardingInputNode extends OnboardingCredentials {
  name: string
  publicIp: string
  sshPort?: number
  sshFingerprint?: string
  machineGroup?: string
  regionGroup?: string
  countryCode?: string
}
export interface OnboardingInput {
  requestId: string
  name: string
  accountLabel: string
  defaults: OnboardingDefaults
  credentials?: OnboardingCredentials
  nodes: OnboardingInputNode[]
}
export type OnboardingTargetInput = Omit<OnboardingInputNode, 'publicIp'> & (
  { publicIp: string; address?: never } | { address: string; publicIp?: never }
)
export type OnboardingRequest = Omit<OnboardingInput, 'nodes'> & { nodes: OnboardingTargetInput[] }

export function normalizeOnboardingAddress(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 254) throw new OnboardingError('HOST_ADDRESS_INVALID')
  const address = value.trim().toLowerCase().replace(/\.$/, '')
  if (isIPv4(address)) {
    if (!isOnboardingPublicIPv4(address)) throw new OnboardingError('PUBLIC_IPV4_REQUIRED')
    return address
  }
  // Accept hostnames only, never URLs, userinfo, ports, or local search names.
  if (/[\s/:@\\?#%]/.test(address)) throw new OnboardingError('HOST_ADDRESS_INVALID')
  const hostname = domainToASCII(address)
  const labels = hostname.split('.')
  if (!hostname || hostname.length > 253 || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels[labels.length - 1]) ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(hostname)) throw new OnboardingError('HOST_ADDRESS_INVALID')
  return hostname
}

async function resolveIPv4(hostname: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 4000, tries: 1 })
  try { return await resolver.resolve4(hostname) }
  finally { resolver.cancel() }
}

export async function resolveOnboardingInput(input: OnboardingRequest, resolve = resolveIPv4): Promise<OnboardingInput> {
  validateOnboardingInput(input)
  const nodes = await Promise.all(input.nodes.map(async row => {
    const { address: suppliedAddress, ...node } = row
    if (node.publicIp) return { ...node, publicIp: node.publicIp }
    const address = normalizeOnboardingAddress(suppliedAddress)
    let publicIp = address
    if (!isIPv4(address)) {
      let records: string[]
      try { records = await resolve(address) }
      catch { throw new OnboardingError('HOST_ADDRESS_UNRESOLVED') }
      if (!records.length) throw new OnboardingError('HOST_ADDRESS_UNRESOLVED')
      if (records.some(ip => !isOnboardingPublicIPv4(ip))) throw new OnboardingError('PUBLIC_IPV4_REQUIRED')
      const unique = [...new Set(records)]
      if (unique.length !== 1) throw new OnboardingError('HOST_ADDRESS_MULTIPLE')
      publicIp = unique[0]
    }
    // Persist the validated IP. The worker must never resolve the name again.
    return { ...node, publicIp }
  }))
  if (new Set(nodes.map(node => node.publicIp)).size !== nodes.length) throw new OnboardingError('DUPLICATE_IMPORT_ROW')
  return { ...input, nodes }
}

// Onboarding pins supplied addresses and DNS results to public IPv4 addresses.
// Management endpoints come from the configured gateway, never from input.
export function isOnboardingPublicIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || !isIPv4(value)) return false
  const [a, b, c] = value.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export function validHostGroup(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function validateCredentials(value: unknown): asserts value is OnboardingCredentials {
  if (!isRecord(value)) throw new OnboardingError('SSH_CREDENTIALS_REQUIRED')
  const { password, privateKey } = value
  if (password !== undefined && (typeof password !== 'string' || password.length > 1024 || password.includes('\0'))) throw new OnboardingError('SSH_CREDENTIALS_INVALID')
  if (privateKey !== undefined && (typeof privateKey !== 'string' || privateKey.length > 32768 || (privateKey !== '' && !/^-----BEGIN (OPENSSH |RSA |EC |)PRIVATE KEY-----\r?\n/.test(privateKey)))) throw new OnboardingError('SSH_CREDENTIALS_INVALID')
  if ((!password && !privateKey) || (password && privateKey)) throw new OnboardingError('SSH_CREDENTIALS_REQUIRED')
}

export function onboardingCredentials(row: OnboardingCredentials, shared?: OnboardingCredentials): OnboardingCredentials {
  const source = row.password || row.privateKey ? row : shared || {}
  return { password: source.password || undefined, privateKey: source.privateKey || undefined }
}

export function validateOnboardingInput(input: unknown): asserts input is OnboardingRequest {
  if (!isRecord(input) || typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId)) throw new OnboardingError('INVALID_REQUEST_ID')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\r\n\0]/.test(input.name)) throw new OnboardingError('BATCH_NAME_REQUIRED')
  if (typeof input.accountLabel !== 'string' || input.accountLabel.length > 80 || /[\r\n\0]/.test(input.accountLabel)) throw new OnboardingError('ACCOUNT_LABEL_INVALID')
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 50) throw new OnboardingError('BATCH_SIZE_INVALID')
  const defaults = input.defaults
  if (!isRecord(defaults) || typeof defaults.countryCode !== 'string' || !/^[a-z]{2}$/.test(defaults.countryCode) || !['tcp', 'tcp_udp'].includes(String(defaults.portProtocol)) ||
      !boundedInteger(defaults.storageSize, 10, 10000) || !boundedInteger(defaults.cpuAllowanceMax, 1, 100000) ||
      !boundedInteger(defaults.memoryMax, 256, 1048576)) throw new OnboardingError('BATCH_DEFAULTS_INVALID')
  for (const group of [defaults.machineGroup, defaults.regionGroup]) {
    if (group !== undefined && group !== '' && !validHostGroup(group)) throw new OnboardingError('HOST_GROUP_INVALID')
  }
  const names = new Set<string>(), addresses = new Set<string>()
  for (const row of input.nodes) {
    if (!isRecord(row) || typeof row.name !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/.test(row.name)) throw new OnboardingError('HOST_NAME_INVALID')
    if ((row.publicIp === undefined) === (row.address === undefined)) throw new OnboardingError('HOST_ADDRESS_INVALID')
    const address = row.address === undefined ? row.publicIp : normalizeOnboardingAddress(row.address)
    if (row.address === undefined && !isOnboardingPublicIPv4(address)) throw new OnboardingError('PUBLIC_IPV4_REQUIRED')
    if (!boundedInteger(row.sshPort ?? 22, 1, 65535)) throw new OnboardingError('SSH_PORT_INVALID')
    for (const group of [row.machineGroup, row.regionGroup]) {
      if (group !== undefined && !validHostGroup(group)) throw new OnboardingError('HOST_GROUP_INVALID')
    }
    if (row.countryCode !== undefined && (typeof row.countryCode !== 'string' || !/^[a-z]{2}$/.test(row.countryCode))) throw new OnboardingError('BATCH_DEFAULTS_INVALID')
    if (row.sshFingerprint !== undefined && (typeof row.sshFingerprint !== 'string' || (row.sshFingerprint !== '' && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.sshFingerprint)))) throw new OnboardingError('SSH_FINGERPRINT_INVALID')
    if (names.has(row.name) || addresses.has(String(address))) throw new OnboardingError('DUPLICATE_IMPORT_ROW')
    names.add(row.name); addresses.add(String(address))
    validateCredentials(row.password || row.privateKey ? row : input.credentials || {})
  }
}

export function onboardingPanelOrigin(): string {
  const configured = process.env.PUBLIC_URL?.trim() || process.env.FRONTEND_URL?.split(',')[0]?.trim() || ''
  try {
    const url = new URL(configured)
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin
  } catch { /* Report a stable code without echoing configuration. */ }
  throw new OnboardingError('PANEL_HTTPS_REQUIRED')
}

export function shellQuote(value: string | number): string {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'"
}
