import { isIPv4 } from 'net'

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

// Onboarding connects only to explicit public IPv4 addresses. Management
// endpoints come from the configured gateway, never from an import row.
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

export function onboardingCredentials(row: OnboardingInputNode, shared?: OnboardingCredentials): OnboardingCredentials {
  const source = row.password || row.privateKey ? row : shared || {}
  return { password: source.password || undefined, privateKey: source.privateKey || undefined }
}

export function validateOnboardingInput(input: unknown): asserts input is OnboardingInput {
  if (!isRecord(input) || typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId)) throw new OnboardingError('INVALID_REQUEST_ID')
  if (![input.name, input.accountLabel].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\r\n\0]/.test(value))) throw new OnboardingError('BATCH_NAME_REQUIRED')
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
    if (!isOnboardingPublicIPv4(row.publicIp)) throw new OnboardingError('PUBLIC_IPV4_REQUIRED')
    if (!boundedInteger(row.sshPort ?? 22, 1, 65535)) throw new OnboardingError('SSH_PORT_INVALID')
    for (const group of [row.machineGroup, row.regionGroup]) {
      if (group !== undefined && !validHostGroup(group)) throw new OnboardingError('HOST_GROUP_INVALID')
    }
    if (row.countryCode !== undefined && (typeof row.countryCode !== 'string' || !/^[a-z]{2}$/.test(row.countryCode))) throw new OnboardingError('BATCH_DEFAULTS_INVALID')
    if (row.sshFingerprint !== undefined && (typeof row.sshFingerprint !== 'string' || (row.sshFingerprint !== '' && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.sshFingerprint)))) throw new OnboardingError('SSH_FINGERPRINT_INVALID')
    if (names.has(row.name) || addresses.has(row.publicIp)) throw new OnboardingError('DUPLICATE_IMPORT_ROW')
    names.add(row.name); addresses.add(row.publicIp)
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
