import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const source = path => readFileSync(new URL(path, root), 'utf8')
function fn(path, name) {
  const text = source(path), start = text.indexOf(`${name}() {`)
  assert.ok(start >= 0)
  return name === 'init_incus' ? text.slice(start) : text.slice(start, text.indexOf('\n}', start) + 2)
}
const stubs = 'info() { :; }; step() { :; }; log() { :; }; warn() { :; }; error() { echo "$*" >&2; };\n'
function run(code, env = {}) {
  return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', code], { encoding: 'utf8', env: { ...process.env, BASH_ENV: '', ...env } })
}
function temp(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'incudal-node-test-'))
  try { callback(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
test('OpenRC PPS guard loads rules once and propagates loader failures', () => temp(dir => {
  const unit = source('server/templates/install/pps.sh')
    .match(/cat > \/etc\/init\.d\/incudal-pps-guard <<'EOF'\n([\s\S]*?)\nEOF/)[1]
    .replace('/usr/local/sbin/incudal-pps-guard', '"$TEST_GUARD"')
  const guard = join(dir, 'guard')
  writeFileSync(guard, '#!/bin/sh\nprintf "loaded\\n" >> "$TRACE"\nexit "$GUARD_STATUS"\n', { mode: 0o755 })
  for (const status of [0, 19]) {
    const trace = join(dir, `trace-${status}`)
    const result = run(`ebegin() { :; }; eend() { return "$1"; };\n${unit}\n[[ -z "\${command:-}" ]]\nif start; then exit 0; else exit $?; fi`, {
      TEST_GUARD: guard, TRACE: trace, GUARD_STATUS: String(status)
    })
    assert.equal(result.status, status, result.stderr)
    assert.equal(readFileSync(trace, 'utf8'), 'loaded\n')
  }
  const dependencies = run(`need() { :; }; after() { printf 'after %s\\n' "$*"; }; before() { printf 'before %s\\n' "$*"; };\n${unit}\ndepend`)
  assert.equal(dependencies.status, 0, dependencies.stderr)
  assert.match(dependencies.stdout, /^after .*\bincusd\b/m)
  assert.match(dependencies.stdout, /^before incudal-agent$/m)
}))

for (const existing of ['yes', 'no']) {
  test(`Incus initialization with existing bridge=${existing}`, () => temp(dir => {
    const code = stubs + `
prepare_incus_dnsmasq() { :; }
ensure_selected_storage_pool() { :; }
ensure_default_profile() { :; }
incus() {
  printf '%s\\n' "$*" >> "$TRACE"
  case "$1 $2" in
    'network show') [[ "$EXISTING" == yes ]] ;;
    'admin init') [[ $# == 3 && "$3" == --preseed ]] || return 17; cat > "$CAPTURE" ;;
    'config set') [[ "$3" == core.https_address && "$4" == '[::]:10001' ]] ;;
    *) return 19 ;;
  esac
}
` + fn('server/templates/install/incus.sh', 'init_incus') + '\ninit_incus'
    const result = run(code, { EXISTING: existing, TRACE: join(dir, 'trace'), CAPTURE: join(dir, 'capture'), PRESEED_FILE: join(dir, 'preseed'), BRIDGE_NAME: 'incusbr0', BRIDGE_SUBNET: '10.10.0.1/22', LISTEN_PORT: '10001', MODE: 'nat', IS_PURE_IPV6: 'false', STORAGE_DRIVER: 'none' })
    assert.equal(result.status, 0, result.stderr)
    if (existing === 'yes') assert.match(readFileSync(join(dir, 'trace'), 'utf8'), /config set core.https_address \[::\]:10001/)
    else assert.match(readFileSync(join(dir, 'capture'), 'utf8'), /core.https_address: '\[::\]:10001'/)
  }))
}
test('existing pool with a different driver fails without recreating data', () => {
  const code = stubs + source('server/templates/install/storage.sh') + `
incus() { [[ "$1 $2" == 'storage show' ]] || exit 88; printf 'driver: zfs\\n'; }
ensure_selected_storage_pool
`
  const result = run(code, { STORAGE_DRIVER: 'dir', STORAGE_POOL_NAME: 'default' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /不符/)
})
test('storage loop size rejects zero and accepts valid nonzero sizes', () => {
  const code = source('server/templates/install/storage.sh') + '\nnormalize_storage_size "$SIZE"'
  for (const value of ['0', '000', '0GiB', '000MB']) assert.equal(run(code, { SIZE: value }).status, 1)
  for (const value of ['1', '60GiB', '100GB']) assert.equal(run(code, { SIZE: value }).status, 0)
})
test('explicit storage options survive interactive terminal invocation', () => temp(dir => {
  const script = join(dir, 'test.sh')
  writeFileSync(script, 'set -euo pipefail\n' + stubs + source('server/templates/install/storage.sh') + '\nprompt_storage_pool\n[[ "$STORAGE_DRIVER" == zfs && "$STORAGE_POOL_NAME" == data && "$STORAGE_SIZE" == 20GiB ]]\n')
  const result = spawnSync('script', ['-qec', 'bash "$TEST_SCRIPT"', '/dev/null'], { input: '', encoding: 'utf8', timeout: 5000, env: { ...process.env, BASH_ENV: '', TEST_SCRIPT: script, STORAGE_OPTION_EXPLICIT: 'true', STORAGE_DRIVER: 'zfs', STORAGE_POOL_NAME: 'data', STORAGE_SIZE: '20GiB' } })
  assert.equal(result.status, 0, result.stderr + result.stdout)
}))
test('certificate import uses exact certificate fingerprint, not a panel name', () => temp(dir => {
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=test'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  const fingerprint = spawnSync('openssl', ['x509', '-in', cert, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).stdout.trim().split('=')[1].replaceAll(':', '').toLowerCase()
  const code = stubs + `
curl() { cp "$CERT" "\${@: -1}"; }
incus() {
  if [[ "$1 $2 $3" == 'config trust list' ]]; then
    [[ "$4 $5" == '--format json' && $# == 5 ]] || return 23
    printf '%s\\n' "$TRUSTED"
  elif [[ "$1 $2 $3" == 'config trust add-certificate' ]]; then printf 'added\\n' >> "$TRACE";
  else return 1; fi
}
` + fn('server/templates/install/agent.sh', 'import_cert') + '\nimport_cert'
  for (const [trusted, added] of [
    [[{ name: 'panel', fingerprint: '0'.repeat(64) }], true],
    [[{ name: 'panel', fingerprint }], false],
    [[], true]
  ]) {
    const trace = join(dir, 'trace'); writeFileSync(trace, '')
    const result = run(code, { CERT: cert, TRUSTED: JSON.stringify(trusted), TRACE: trace, PANEL_URL: 'https://panel.example.test', TOKEN: 'test-token' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(trace, 'utf8').includes('added'), added)
  }
}))
test('Agent binary download failure does not consume install token; custom binary directory exists before manifest download', () => temp(dir => {
  mkdirSync(join(dir, 'bin'))
  const trace = join(dir, 'trace')
  writeFileSync(join(dir, 'bin', 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
[[ -d "$EXPECTED_DIR" ]] || exit 33
exit 7
`, { mode: 0o755 })
  const result = spawnSync('bash', [new URL('server/templates/agent-install.sh', root).pathname], { encoding: 'utf8', env: { ...process.env, BASH_ENV: '', PATH: join(dir, 'bin') + ':' + process.env.PATH, TRACE: trace, EXPECTED_DIR: join(dir, 'custom'), INCUDAL_AGENT_BIN: join(dir, 'custom', 'agent'), INCUDAL_PANEL_URL: 'https://panel.example.test', INCUDAL_AGENT_INSTALL_TOKEN: 'test-token' } })
  assert.equal(result.status, 7, result.stderr)
  const calls = readFileSync(trace, 'utf8')
  assert.match(calls, /manifest.json/)
  assert.doesNotMatch(calls, /install-config/)
}))

test('rerun retains the existing bridge subnet without selecting a new network', () => {
  const code = stubs + fn('server/templates/install/prelude.sh', 'select_bridge_subnet') + `
incus() { printf '10.20.0.1/22\\n'; }
ip() { exit 91; }
select_bridge_subnet
[[ "$BRIDGE_SUBNET" == 10.20.0.1/22 ]]
`
  const result = run(code, { BRIDGE_NAME: 'incusbr0', BRIDGE_SUBNET: '10.10.0.1/22' })
  assert.equal(result.status, 0, result.stderr)
})

test('APT can read the public signing key when installation uses umask 077', () => temp(dir => {
  mkdirSync(join(dir, 'sources'))
  const install = fn('server/templates/install/incus.sh', 'install_incus')
    .replaceAll('/etc/apt/keyrings', '"$TEST_ROOT/keyrings"')
    .replaceAll('/etc/apt/sources.list.d', '"$TEST_ROOT/sources"')
  const code = stubs + `
umask 077
incus() { return 1; }
curl() { printf 'public signing key'; }
gpg() { cat > "\${@: -1}"; }
ensure_root_idmap() { return 1; }
wait_for_incus_daemon() { return 0; }
systemctl() { :; }
apt-get() {
  [[ "$1" != update ]] && return 0
  [[ $(stat -c %a "$TEST_ROOT/keyrings") == 755 ]] || return 71
  [[ $(stat -c %a "$TEST_ROOT/keyrings/zabbly.gpg") == 644 ]] || return 72
  [[ $(stat -c %a "$TEST_ROOT/sources/zabbly-incus-stable.sources") == 644 ]] || return 73
}
` + install + '\ninstall_incus'
  const result = run(code, { TEST_ROOT: dir, OS_ID: 'ubuntu', OS_CODENAME: 'resolute', ARCH: 'amd64' })
  assert.equal(result.status, 0, result.stderr)
}))

const ociNetworkSource = source('scripts/configure-oci-node-network.sh')
const networkEnv = {
  control_ip: '10.253.240.1', management_interface: 'incudal-mgmt',
  api_port: '8443', bridge: 'incusbr0', bridge_cidr: '10.10.0.1/22',
  uplink: 'eth0', dedicated_ip: '10.10.0.2', bind_ip: '10.0.0.116', client_ports: ''
}

test('dedicated forwarding requires a separate management interface and valid IPv4 addresses', () => {
  const validation = ociNetworkSource.slice(
    ociNetworkSource.indexOf('[[ -z "$management_interface"'),
    ociNetworkSource.indexOf('\nfor command in ip iptables ip6tables;')
  )
  assert.equal(run(validation, networkEnv).status, 0)
  for (const invalid of [
    { management_interface: '' }, { management_interface: 'wg0;id' },
    { bind_ip: '' }, { bind_ip: '127.0.0.1' },
    { dedicated_ip: 'not-an-address' }, { client_ports: '10000:10099' }
  ]) {
    assert.notEqual(run(validation, { ...networkEnv, ...invalid }).status, 0, JSON.stringify(invalid))
  }
})

for (const dedicated of [true, false]) {
  test(`OCI firewall preserves host rules and isolates guests, dedicated=${dedicated}`, () => temp(dir => {
    const trace = join(dir, 'trace')
    const code = `
iptables() {
  printf 'v4 %s\\n' "$*" >> "$TRACE"
  case " $* " in *' -C '*|*' -S INCUDAL_OCI_NAT '*) return 1 ;; esac
  return 0
}
ip6tables() {
  printf 'v6 %s\\n' "$*" >> "$TRACE"
  case " $* " in *' -C '*) return 1 ;; esac
  return 0
}
` + fn('scripts/configure-oci-node-network.sh', 'configure_oci_rules') + '\nconfigure_oci_rules'
    const result = run(code, {
      ...networkEnv, TRACE: trace,
      ...(dedicated ? {} : { dedicated_ip: '', bind_ip: '', management_interface: '', control_ip: '203.0.113.10', client_ports: '10000:10099' })
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = readFileSync(trace, 'utf8')
    assert.doesNotMatch(calls, / -[FX] (INPUT|OUTPUT|FORWARD|InstanceServices)(?: |$)/m)
    assert.doesNotMatch(calls, / -P /)
    assert.match(calls, /-A INCUDAL_OCI_IN -i incusbr0 -j REJECT/)
    assert.match(calls, /v6 .* -A INCUDAL_OCI_IN -i incusbr0 -j REJECT/)
    assert.ok(calls.indexOf('-d 169.254.0.0/16 -j REJECT') < calls.indexOf('-s 10.10.0.1/22 -o eth0 -j ACCEPT'))
    const forwarding = calls.split('\n').filter(line => line.includes('-t nat -A INCUDAL_OCI_NAT'))
    assert.equal(forwarding.length, dedicated ? 2 : 0)
    if (dedicated) {
      for (const protocol of ['tcp', 'udp']) {
        assert.ok(forwarding.some(line => line.endsWith(`-i eth0 -d 10.0.0.116/32 -p ${protocol} -j DNAT --to-destination 10.10.0.2`)))
      }
      assert.match(calls, /-s 10.253.240.1\/32 -i incudal-mgmt -p tcp --dport 8443 -j ACCEPT/)
      assert.ok(calls.indexOf('-d 10.0.0.0/8 -j REJECT') < calls.indexOf('-s 10.10.0.1/22 -o eth0 -j ACCEPT'))
    } else {
      assert.match(calls, /--dport 10000:10099 -j ACCEPT/)
    }
  }))
}

for (const initSystem of ['openrc', 'systemd']) {
  test(`OCI network persistence supports ${initSystem} under umask 077`, () => temp(dir => {
    mkdirSync(join(dir, 'init.d'))
    mkdirSync(join(dir, 'systemd'))
    const testScript = join(dir, 'source-network.sh')
    writeFileSync(testScript, '#!/bin/sh\nexit 0\n')
    const start = ociNetworkSource.indexOf('persist_oci_network() {')
    const persistence = ociNetworkSource.slice(start, ociNetworkSource.indexOf('\nconfigure_oci_rules\n', start))
      .replaceAll('/usr/local/sbin/incudal-oci-network', '"$TEST_ROOT/local/sbin/incudal-oci-network"')
      .replaceAll('"$0"', '"$TEST_SCRIPT"')
      .replaceAll('/etc/init.d/incudal-oci-network', '"$TEST_ROOT/init.d/incudal-oci-network"')
      .replaceAll('/etc/systemd/system/incudal-oci-network.service', '"$TEST_ROOT/systemd/incudal-oci-network.service"')
    const code = `
umask 077
rc-update() { printf 'rc-update %s\\n' "$*" >> "$TRACE"; }
rc-service() { printf 'rc-service %s\\n' "$*" >> "$TRACE"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$TRACE"; }
` + persistence + '\npersist_oci_network'
    const result = run(code, { ...networkEnv, init_system: initSystem, TEST_ROOT: dir, TEST_SCRIPT: testScript, TRACE: join(dir, 'trace') })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(dir, 'local/sbin/incudal-oci-network'), 'utf8'), readFileSync(testScript, 'utf8'))
    const path = join(dir, initSystem === 'openrc' ? 'init.d/incudal-oci-network' : 'systemd/incudal-oci-network.service')
    const service = readFileSync(path, 'utf8')
    assert.match(service, /--management-interface incudal-mgmt --dedicated-ip 10.10.0.2 --bind-ip 10.0.0.116/)
    assert.doesNotMatch(service, /--persist/)
    assert.equal(statSync(path).mode & 0o777, initSystem === 'openrc' ? 0o755 : 0o644)
    if (initSystem === 'openrc') {
      assert.match(service, /need net incusd/)
      assert.match(service, /after firewall iptables ip6tables wg-quick.incudal-mgmt/)
      assert.equal(spawnSync('sh', ['-n', path], { encoding: 'utf8' }).status, 0)
      assert.match(readFileSync(join(dir, 'trace'), 'utf8'), /rc-update add incudal-oci-network default/)
      const attempts = join(dir, 'attempts')
      writeFileSync(join(dir, 'local/sbin/incudal-oci-network'), `#!/bin/sh
attempt=$(cat "$TEST_ATTEMPTS")
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "$TEST_ATTEMPTS"
[ "$attempt" -ge "$TEST_READY_AFTER" ]
`, { mode: 0o755 })
      for (const [readyAfter, status, calls] of [[3, 0, 3], [100, 1, 60]]) {
        writeFileSync(attempts, '0')
        const startup = run('ebegin() { :; }; eend() { return "$1"; }; sleep() { :; };\n. "$SERVICE"\nif start; then exit 0; else exit $?; fi', {
          SERVICE: path, TEST_ATTEMPTS: attempts, TEST_READY_AFTER: String(readyAfter)
        })
        assert.equal(startup.status, status, startup.stderr)
        assert.equal(Number(readFileSync(attempts, 'utf8')), calls)
      }
    } else {
      assert.match(service, /After=.*wg-quick@incudal-mgmt.service/)
      assert.match(readFileSync(join(dir, 'trace'), 'utf8'), /systemctl enable --now incudal-oci-network.service/)
    }
  }))
}
