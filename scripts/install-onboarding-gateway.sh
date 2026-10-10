#!/usr/bin/env bash
# Install the restricted management gateway on the control server.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run this script as root.' >&2; exit 1; }
app_key_path="${1:-/opt/incudal-oci/server/certs/onboarding-gateway.key}"
[[ "$app_key_path" = /* && "$app_key_path" != /root/.ssh/incudal-host-management ]] || { echo 'Use an absolute path for a dedicated application key.' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for tool in python3 wg ssh-keygen; do command -v "$tool" >/dev/null; done
wg show incudal-mgmt public-key >/dev/null
test -f /etc/wireguard/incudal-mgmt.conf
install -d -m 700 /root/.ssh
install -d -m 700 /var/lib/incudal-onboarding
install -d /usr/local/sbin
install -m 755 "$script_dir/onboarding-gateway.py" /usr/local/sbin/incudal-onboarding-gateway

if [[ ! -f /root/.ssh/incudal-host-management ]]; then
  ssh-keygen -q -t ed25519 -N '' -C incudal-control-management -f /root/.ssh/incudal-host-management
fi
ssh-keygen -y -f /root/.ssh/incudal-host-management > /root/.ssh/incudal-host-management.pub
install -d -m 700 "$(dirname -- "$app_key_path")"
if [[ ! -f "$app_key_path" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C incudal-onboarding-gateway -f "$app_key_path"
fi
app_public_key=$(ssh-keygen -y -f "$app_key_path")
management_public_key=$(cat /root/.ssh/incudal-host-management.pub)
[[ "$app_public_key" != "$management_public_key" ]] || { echo 'The application and host management keys must be different.' >&2; exit 1; }
authorized_line="restrict,command=\"/usr/local/sbin/incudal-onboarding-gateway\" $app_public_key incudal-onboarding-gateway"
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys "$app_key_path" /root/.ssh/incudal-host-management
if ! grep -Fxq "$authorized_line" /root/.ssh/authorized_keys; then
  if grep -Fq "$app_public_key" /root/.ssh/authorized_keys; then
    echo 'The application key is already authorized with different restrictions.' >&2
    exit 1
  fi
  printf '\n%s\n' "$authorized_line" >> /root/.ssh/authorized_keys
fi
SSH_ORIGINAL_COMMAND=status /usr/local/sbin/incudal-onboarding-gateway
printf '\nGateway SSH host fingerprint:\n'
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
printf '\nSet ONBOARDING_GATEWAY_HOST, ONBOARDING_GATEWAY_KEY_PATH, ONBOARDING_GATEWAY_FINGERPRINT, ONBOARDING_WG_ENDPOINT and ONBOARDING_SSH_JUMP_HOST in the panel environment, then recreate the app container.\n'
