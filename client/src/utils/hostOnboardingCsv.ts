import type { OnboardingInputNode } from '@/types/api'

export class OnboardingCsvError extends Error {
  constructor(public readonly code: string, public readonly row = 0) { super(code) }
}

// Parse quoted CSV (including multiline private keys) or tab-separated exports.
// Error messages contain row numbers only, never imported credentials.
export function parseHostOnboardingCsv(text: string): OnboardingInputNode[] {
  if (text.length > 2 * 1024 * 1024 || text.includes('\0')) throw new OnboardingCsvError('CSV_TOO_LARGE')
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return []
  const delimiter = source.split('\n', 1)[0].includes('\t') ? '\t' : ','
  const records: string[][] = []
  let record: string[] = [], field = '', quoted = false, closed = false
  const finishField = () => { record.push(field); field = ''; closed = false }
  const finishRecord = () => {
    finishField()
    if (record.some(value => value.trim())) records.push(record)
    record = []
    if (records.length > 51) throw new OnboardingCsvError('BATCH_SIZE_INVALID')
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (source[index + 1] === '"') { field += '"'; index++ }
      else { quoted = false; closed = true }
    } else if (char === delimiter) finishField()
    else if (char === '\n') finishRecord()
    else if (char === '"' && field === '' && !closed) quoted = true
    else if (closed || char === '"') throw new OnboardingCsvError('CSV_INVALID', records.length + 1)
    else field += char
  }
  if (quoted) throw new OnboardingCsvError('CSV_INVALID', records.length + 1)
  if (record.length || field || closed) finishRecord()
  const headers = records.shift()?.map(value => value.trim()) || []
  const allowed = new Set(['name', 'publicIp', 'sshPort', 'sshFingerprint', 'password', 'privateKey', 'machineGroup', 'regionGroup', 'countryCode'])
  if (!headers.includes('name') || !headers.includes('publicIp') || new Set(headers).size !== headers.length || headers.some(header => !allowed.has(header))) throw new OnboardingCsvError('CSV_HEADERS')
  const names = new Set<string>(), addresses = new Set<string>()
  return records.map((fields, index) => {
    const row = index + 2
    if (fields.length !== headers.length) throw new OnboardingCsvError('CSV_INVALID', row)
    const values = Object.fromEntries(headers.map((header, column) => [header, fields[column]]))
    const name = values.name.trim(), publicIp = values.publicIp.trim()
    const port = values.sshPort?.trim() || '22'
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(name)) throw new OnboardingCsvError('HOST_NAME_INVALID', row)
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(publicIp) || publicIp.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part)) throw new OnboardingCsvError('PUBLIC_IPV4_REQUIRED', row)
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new OnboardingCsvError('SSH_PORT_INVALID', row)
    const sshFingerprint = values.sshFingerprint?.trim() || undefined
    const machineGroup = values.machineGroup?.trim() || undefined, regionGroup = values.regionGroup?.trim() || undefined
    const countryCode = values.countryCode?.trim().toLowerCase() || undefined
    if ([machineGroup, regionGroup].some(group => group && (group.length > 60 || [...group].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) throw new OnboardingCsvError('HOST_GROUP_INVALID', row)
    if (countryCode && !/^[a-z]{2}$/.test(countryCode)) throw new OnboardingCsvError('BATCH_DEFAULTS_INVALID', row)
    if (sshFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(sshFingerprint)) throw new OnboardingCsvError('SSH_FINGERPRINT_INVALID', row)
    if (names.has(name) || addresses.has(publicIp)) throw new OnboardingCsvError('DUPLICATE_IMPORT_ROW', row)
    names.add(name); addresses.add(publicIp)
    return { name, publicIp, sshPort: Number(port), sshFingerprint, machineGroup, regionGroup, countryCode, password: values.password || undefined, privateKey: values.privateKey || undefined }
  })
}
