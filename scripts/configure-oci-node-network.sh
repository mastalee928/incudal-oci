#!/usr/bin/env bash
# Allow Incus through the OCI image firewall without removing InstanceServices.
set -euo pipefail

control_ip=""
bridge="incusbr0"
api_port="8443"
client_ports=""
persist="false"

usage() {
    echo "Usage: $0 --control-ip <IPv4> [--bridge incusbr0] [--api-port 8443] [--client-ports 10000:10099] [--persist]"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --control-ip|--bridge|--api-port|--client-ports)
            [[ $# -ge 2 ]] || { usage >&2; exit 1; }
            case "$1" in
                --control-ip) control_ip="$2" ;;
                --bridge) bridge="$2" ;;
                --api-port) api_port="$2" ;;
                --client-ports) client_ports="$2" ;;
            esac
            shift 2 ;;
        --persist) persist="true"; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
done

[[ "$EUID" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ "$bridge" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$ ]] || { echo "Invalid bridge name" >&2; exit 1; }
python3 - "$control_ip" "$api_port" "$client_ports" <<'PY'
import ipaddress
import sys
try:
    address = ipaddress.IPv4Address(sys.argv[1])
    if address.is_unspecified or address.is_multicast:
        raise ValueError()
    port = int(sys.argv[2])
    if not sys.argv[2].isdigit() or not 1 <= port <= 65535 or port == 22:
        raise ValueError()
    if sys.argv[3]:
        start, end = map(int, sys.argv[3].split(':'))
        if not 1 <= start <= end <= 65535 or start <= port <= end or start <= 22 <= end:
            raise ValueError()
except ValueError:
    sys.exit('Invalid control IP or port range; reserve SSH and the Incus API port')
PY

for command in ip iptables ip6tables; do
    command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
if [[ "$persist" == "true" ]] && ! command -v systemctl >/dev/null; then
    echo "--persist currently requires systemd; configure startup separately on OpenRC" >&2
    exit 1
fi

uplink=$(ip -4 route show default | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
bridge_cidr=$(ip -o -4 addr show dev "$bridge" | awk 'NR==1 {print $4}')
[[ -n "$uplink" && -n "$bridge_cidr" && "$uplink" != "$bridge" ]] || {
    echo "An IPv4 default route and initialized Incus bridge are required" >&2
    exit 1
}

# Only these Incudal-owned chains are rebuilt. OCI's INPUT/FORWARD policies,
# SSH rules, and the OUTPUT InstanceServices chain are retained.
for chain in INCUDAL_OCI_IN INCUDAL_OCI_FWD; do
    iptables -w -N "$chain" 2>/dev/null || iptables -w -S "$chain" >/dev/null
    iptables -w -F "$chain"
done
iptables -w -A INCUDAL_OCI_IN -i lo -p tcp --dport "$api_port" -j ACCEPT
iptables -w -A INCUDAL_OCI_IN -s "$control_ip/32" -p tcp --dport "$api_port" -j ACCEPT
iptables -w -A INCUDAL_OCI_IN -p tcp --dport "$api_port" -j REJECT --reject-with tcp-reset
iptables -w -A INCUDAL_OCI_IN -i "$bridge" -p udp -m multiport --dports 53,67 -j ACCEPT
iptables -w -A INCUDAL_OCI_IN -i "$bridge" -p tcp --dport 53 -j ACCEPT
if [[ -n "$client_ports" ]]; then
    iptables -w -A INCUDAL_OCI_IN -p tcp --dport "$client_ports" -j ACCEPT
    iptables -w -A INCUDAL_OCI_IN -p udp --dport "$client_ports" -j ACCEPT
fi

# Container traffic uses FORWARD, so the OCI host's OUTPUT restrictions do not
# protect instance metadata. Deny that destination before allowing egress.
iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -s "$bridge_cidr" -o "$uplink" -j ACCEPT
iptables -w -A INCUDAL_OCI_FWD -o "$bridge" -d "$bridge_cidr" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A INCUDAL_OCI_FWD -o "$bridge" -d "$bridge_cidr" -m conntrack --ctstate DNAT -j ACCEPT

for entry in 'INPUT INCUDAL_OCI_IN' 'FORWARD INCUDAL_OCI_FWD'; do
    read -r parent chain <<< "$entry"
    while iptables -w -C "$parent" -j "$chain" 2>/dev/null; do
        iptables -w -D "$parent" -j "$chain"
    done
    iptables -w -I "$parent" 1 -j "$chain"
done

# This deployment uses an IPv4 control address. Do not leave the Incus [::]
# listener publicly reachable if the host later receives an IPv6 address.
ip6tables -w -N INCUDAL_OCI_IN 2>/dev/null || ip6tables -w -S INCUDAL_OCI_IN >/dev/null
ip6tables -w -F INCUDAL_OCI_IN
ip6tables -w -A INCUDAL_OCI_IN -i lo -p tcp --dport "$api_port" -j ACCEPT
ip6tables -w -A INCUDAL_OCI_IN -p tcp --dport "$api_port" -j REJECT --reject-with tcp-reset
while ip6tables -w -C INPUT -j INCUDAL_OCI_IN 2>/dev/null; do
    ip6tables -w -D INPUT -j INCUDAL_OCI_IN
done
ip6tables -w -I INPUT 1 -j INCUDAL_OCI_IN

if [[ "$persist" == "true" ]]; then
    target=/usr/local/sbin/incudal-oci-network
    if [[ "$(readlink -f "$0")" != "$target" ]]; then
        install -m 0755 "$0" "$target"
    fi
    cat > /etc/systemd/system/incudal-oci-network.service <<EOF
[Unit]
Description=Incudal networking for OCI IPv4 nodes
Wants=network-online.target
After=network-online.target netfilter-persistent.service incus.service
Before=incudal-agent.service

[Service]
Type=oneshot
ExecStart=${target} --control-ip ${control_ip} --bridge ${bridge} --api-port ${api_port}${client_ports:+ --client-ports ${client_ports}}
RemainAfterExit=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 /etc/systemd/system/incudal-oci-network.service
    systemctl daemon-reload
    systemctl enable --now incudal-oci-network.service
fi

echo "OCI network configured: control=${control_ip}, API=${api_port}, bridge=${bridge}, client_ports=${client_ports:-none}"
