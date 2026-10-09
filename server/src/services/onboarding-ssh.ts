import ssh2, { type Client, type ConnectConfig } from 'ssh2'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { isIPv4 } from 'net'
import { OnboardingError } from '../lib/host-onboarding.js'

export function sshFingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export async function connectOnboardingSsh(config: ConnectConfig, verify: (fingerprint: string) => Promise<boolean>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    let ready = false, mismatch = false
    client.on('error', () => {
      if (!ready) { client.destroy(); reject(new OnboardingError(mismatch ? 'SSH_HOST_KEY_CHANGED' : 'SSH_CONNECT_FAILED')) }
    })
    client.once('close', () => { if (!ready) reject(new OnboardingError(mismatch ? 'SSH_HOST_KEY_CHANGED' : 'SSH_CONNECT_FAILED')) })
    client.once('ready', () => { ready = true; resolve(client) })
    try { client.connect({ ...config, username: 'root', readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
        verify(sshFingerprint(key)).then(valid => { mismatch = !valid; callback(valid) }).catch(() => { mismatch = true; callback(false) })
      }
    }) } catch { client.destroy(); reject(new OnboardingError('SSH_CONNECT_FAILED')) }
  })
}

// No PTY and no shell interpolation of credentials. The script arrives over
// stdin, and only structured, bounded results are returned to the worker.
export async function sshExec(client: Client, command: string, input = '', timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer); client.off('close', onClose)
      if (error) reject(error); else resolve(value || '')
    }
    const onClose = () => finish(new OnboardingError('SSH_DISCONNECTED'))
    client.once('close', onClose)
    const timer = setTimeout(() => { client.destroy(); finish(new OnboardingError('SSH_COMMAND_TIMEOUT')) }, timeoutMs)
    client.exec(command, (error, stream) => {
      if (error) { finish(new OnboardingError('SSH_COMMAND_FAILED')); return }
      if (settled) { stream.close(); return }
      let output = ''
      stream.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-65536) })
      stream.stderr.on('data', () => {})
      stream.on('error', () => finish(new OnboardingError('SSH_COMMAND_FAILED')))
      stream.on('close', (code: number) => {
        if (code !== 0) {
          const known = output.match(/INCUDAL_ERROR:([A-Z_]+)/)
          finish(new OnboardingError(known?.[1] || 'SSH_COMMAND_FAILED'))
        } else finish(undefined, output)
      })
      stream.end(input)
    })
  })
}

export interface OnboardingGateway {
  publicKey: string
  controlIp: string
  network: string
  managementIp?: string
  endpoint: string
  sshHost: string
  managementSshPublicKey: string
}

export function validateGatewayResponse(raw: unknown, endpoint: string, sshHost: string): OnboardingGateway {
  if (!raw || typeof raw !== 'object') throw new OnboardingError('GATEWAY_RESPONSE_INVALID')
  const value = raw as Record<string, unknown>
  const network = typeof value.network === 'string' ? value.network.split('/') : []
  const prefix = Number(network[1])
  const ipv4Number = (ip: string) => ip.split('.').reduce((result, octet) => result * 256 + Number(octet), 0)
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  if (network.length !== 2 || !isIPv4(network[0]) || !Number.isInteger(prefix) || prefix < 16 || prefix > 30 ||
      typeof value.controlIp !== 'string' || !isIPv4(value.controlIp) || !value.controlIp.startsWith('10.') ||
      ((ipv4Number(value.controlIp) & mask) >>> 0) !== ipv4Number(network[0]) ||
      typeof value.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.publicKey)) throw new OnboardingError('GATEWAY_RESPONSE_INVALID')
  if (value.managementIp !== undefined && (typeof value.managementIp !== 'string' || !isIPv4(value.managementIp) || value.managementIp === value.controlIp ||
      ipv4Number(value.managementIp) <= ipv4Number(network[0]) || ipv4Number(value.managementIp) >= ipv4Number(network[0]) + 2 ** (32 - prefix) - 1 ||
      ((ipv4Number(value.managementIp) & mask) >>> 0) !== ipv4Number(network[0]))) throw new OnboardingError('GATEWAY_RESPONSE_INVALID')
  const match = endpoint.match(/^([a-zA-Z0-9][a-zA-Z0-9.-]*):([0-9]{1,5})$/)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(sshHost)) throw new OnboardingError('GATEWAY_RESPONSE_INVALID')
  if (typeof value.managementSshPublicKey !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value.managementSshPublicKey) || value.managementSshPublicKey.length > 200) throw new OnboardingError('GATEWAY_MANAGEMENT_KEY_MISSING')
  if (ssh2.utils.parseKey(value.managementSshPublicKey) instanceof Error) throw new OnboardingError('GATEWAY_MANAGEMENT_KEY_MISSING')
  return { publicKey: value.publicKey, controlIp: value.controlIp, network: String(value.network),
    managementIp: value.managementIp as string | undefined, managementSshPublicKey: value.managementSshPublicKey, endpoint, sshHost }
}

export function gatewayConfigured(): boolean {
  return Boolean(process.env.ONBOARDING_GATEWAY_HOST && process.env.ONBOARDING_GATEWAY_KEY_PATH && process.env.ONBOARDING_GATEWAY_FINGERPRINT && process.env.ONBOARDING_WG_ENDPOINT)
}

export async function gatewayCommand(command = 'status'): Promise<OnboardingGateway> {
  if (!gatewayConfigured()) throw new OnboardingError('GATEWAY_NOT_CONFIGURED')
  const privateKey = await readFile(process.env.ONBOARDING_GATEWAY_KEY_PATH!)
  const client = await connectOnboardingSsh({ host: process.env.ONBOARDING_GATEWAY_HOST!, port: Number(process.env.ONBOARDING_GATEWAY_PORT || 22), privateKey },
    async fingerprint => fingerprint === process.env.ONBOARDING_GATEWAY_FINGERPRINT)
  try {
    let raw: unknown
    try { raw = JSON.parse(await sshExec(client, command)) }
    catch (error) { if (error instanceof OnboardingError) throw error; throw new OnboardingError('GATEWAY_RESPONSE_INVALID') }
    return validateGatewayResponse(raw, process.env.ONBOARDING_WG_ENDPOINT!, process.env.ONBOARDING_SSH_JUMP_HOST || process.env.ONBOARDING_GATEWAY_HOST!)
  } finally { client.end() }
}
