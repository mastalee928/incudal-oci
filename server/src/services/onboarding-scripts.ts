import { shellQuote as q, type OnboardingDefaults } from '../lib/host-onboarding.js'
import type { OnboardingGateway } from './onboarding-ssh.js'

export function preflightScript(id: string): string {
  return `set -eu
fail() { echo "INCUDAL_ERROR:$1"; exit 1; }
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
. /etc/os-release
case "$ID" in alpine|debian|ubuntu|rocky) ;; *) fail OS_UNSUPPORTED ;; esac
if [ -f /etc/incudal-onboarding-id ]; then
  [ "$(cat /etc/incudal-onboarding-id)" = ${q(id)} ] || fail HOST_ALREADY_MANAGED
else
  [ ! -f /etc/wireguard/incudal-mgmt.conf ] || fail HOST_ALREADY_MANAGED
  if command -v incus >/dev/null 2>&1 || command -v lxc >/dev/null 2>&1; then fail HOST_ALREADY_MANAGED; fi
fi
if command -v incus >/dev/null 2>&1; then
  instances=$(incus list --all-projects --format=csv -c n) || fail INCUS_CHECK_FAILED
  [ -z "$instances" ] || fail HOST_HAS_INSTANCES
fi
umask 077
mkdir -p ${q('/root/.incudal-onboarding/' + id)}
printf '%s' ${q(id)} > /etc/incudal-onboarding-id
echo INCUDAL_PREFLIGHT_OK
`
}

export function prepareKeyScript(id: string): string {
  return `set -eu
umask 077
. /etc/os-release
case "$ID" in
 alpine) apk add --no-cache bash curl ca-certificates python3 iproute2 wireguard-tools >/dev/null ;;
 debian|ubuntu) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y bash curl ca-certificates python3 iproute2 wireguard-tools >/dev/null ;;
 rocky) dnf install -y bash curl ca-certificates python3 wireguard-tools >/dev/null ;;
esac
key=${q('/root/.incudal-onboarding/' + id + '/wg.key')}
[ -s "$key" ] || wg genkey > "$key"
printf 'INCUDAL_PUBLIC_KEY:'
wg pubkey < "$key"
printf 'INCUDAL_BIND_IP:'
ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}'
`
}

export function wireguardScript(id: string, gateway: OnboardingGateway): string {
  const authorizedKey = `from="${gateway.controlIp}",no-agent-forwarding,no-X11-forwarding ${gateway.managementSshPublicKey} incudal-control-management`
  return `set -eu
umask 077
mkdir -p /root/.ssh
touch /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
grep -Fxq ${q(authorizedKey)} /root/.ssh/authorized_keys || printf '\\n%s\\n' ${q(authorizedKey)} >> /root/.ssh/authorized_keys
mkdir -p /etc/wireguard
key=$(cat ${q('/root/.incudal-onboarding/' + id + '/wg.key')})
if [ ! -f /etc/wireguard/incudal-mgmt.conf ]; then
  printf '%s\n' '[Interface]' "PrivateKey = $key" ${q('Address = ' + gateway.managementIp + '/32')} 'MTU = 1420' '[Peer]' ${q('PublicKey = ' + gateway.publicKey)} ${q('Endpoint = ' + gateway.endpoint)} ${q('AllowedIPs = ' + gateway.controlIp + '/32')} 'PersistentKeepalive = 25' > /etc/wireguard/incudal-mgmt.conf
else
  grep -Fxq ${q('Address = ' + gateway.managementIp + '/32')} /etc/wireguard/incudal-mgmt.conf &&
  grep -Fxq ${q('PublicKey = ' + gateway.publicKey)} /etc/wireguard/incudal-mgmt.conf || { echo INCUDAL_ERROR:MANAGEMENT_NETWORK_CONFLICT; exit 1; }
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now wg-quick@incudal-mgmt.service >/dev/null
else
  [ -e /etc/init.d/wg-quick.incudal-mgmt ] || ln -s /etc/init.d/wg-quick /etc/init.d/wg-quick.incudal-mgmt
  rc-update add wg-quick.incudal-mgmt default >/dev/null
  rc-service wg-quick.incudal-mgmt status >/dev/null 2>&1 || rc-service wg-quick.incudal-mgmt start
fi
echo INCUDAL_TUNNEL_STARTED
`
}

export function installerStartScript(id: string, attempt: number, url: string, defaults: OnboardingDefaults): string {
  const directory = '/root/.incudal-onboarding/' + id
  const runner = `#!/bin/sh
cd ${q(directory)} || exit 1
printf '%s' "$$" > install.pid
cat /proc/sys/kernel/random/boot_id > install.boot
set +e
bash ./install.sh --mode nat --port 8443 --storage-driver btrfs --storage-size ${q(defaults.storageSize + 'GiB')} </dev/null
code=$?
printf '%s' "$code" > install.exit.tmp
mv install.exit.tmp install.exit
rmdir install.lock
exit "$code"
`
  return `set -eu
umask 077
cd ${q(directory)}
if [ -f install.exit ] && [ "$(cat install.exit)" = 0 ]; then echo INCUDAL_INSTALL_DONE; exit 0; fi
if [ -d install.lock ]; then
  if [ -f install.pid ] && [ -f install.boot ] && [ "$(cat install.boot)" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$(cat install.pid)" 2>/dev/null; then echo INCUDAL_INSTALL_RUNNING; exit 0; fi
  if [ "$(cat install.attempt 2>/dev/null || echo 0)" -ge ${q(attempt)} ]; then echo INCUDAL_ERROR:INSTALL_INTERRUPTED; exit 1; fi
  rmdir install.lock
fi
if [ -f install.exit ] && [ "$(cat install.attempt)" = ${q(attempt)} ]; then echo INCUDAL_ERROR:INSTALL_FAILED; exit 1; fi
mkdir install.lock
printf '%s' ${q(attempt)} > install.attempt
rm -f install.exit
if ! curl --fail --show-error --location --connect-timeout 15 --max-time 120 ${q(url)} -o install.sh; then rmdir install.lock; echo INCUDAL_ERROR:INSTALL_DOWNLOAD_FAILED; exit 1; fi
printf '%s' ${q(runner)} > run.sh
nohup sh ./run.sh >install.log 2>&1 </dev/null &
printf '%s' "$!" > install.pid
echo INCUDAL_INSTALL_RUNNING
`
}

export function installerPollScript(id: string): string {
  return `set -eu
cd ${q('/root/.incudal-onboarding/' + id)}
if [ -f install.exit ]; then
  if [ "$(cat install.exit)" = 0 ]; then echo done; else echo INCUDAL_ERROR:INSTALL_FAILED; exit 1; fi
elif [ -f install.pid ] && [ -f install.boot ] && [ "$(cat install.boot)" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$(cat install.pid)" 2>/dev/null; then
  echo running
else echo INCUDAL_ERROR:INSTALL_INTERRUPTED; exit 1
fi
`
}
