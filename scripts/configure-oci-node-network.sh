#!/usr/bin/env bash
# Allow Incus through the OCI image firewall without removing InstanceServices.
set -euo pipefail

control_ip=""
bridge="incusbr0"
api_port="8443"
client_ports=""
management_interface=""
dedicated_ip=""
bind_ip=""
ssh_port="22"
persist="false"
init_system=""

usage() {
    echo "Usage: $0 --control-ip <IPv4> [--bridge incusbr0] [--api-port 8443] [--ssh-port 22] [--client-ports 10000:10099] [--persist]"
    echo "Dedicated IPv4: --management-interface <interface> --bind-ip <host-private-IPv4> --dedicated-ip <container-IPv4>"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --control-ip|--bridge|--api-port|--client-ports|--management-interface|--dedicated-ip|--bind-ip|--ssh-port)
            [[ $# -ge 2 ]] || { usage >&2; exit 1; }
            case "$1" in
                --control-ip) control_ip="$2" ;;
                --bridge) bridge="$2" ;;
                --api-port) api_port="$2" ;;
                --client-ports) client_ports="$2" ;;
                --management-interface) management_interface="$2" ;;
                --dedicated-ip) dedicated_ip="$2" ;;
                --bind-ip) bind_ip="$2" ;;
                --ssh-port) ssh_port="$2" ;;
            esac
            shift 2 ;;
        --persist) persist="true"; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
done

[[ "$EUID" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ "$bridge" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$ ]] || { echo "Invalid bridge name" >&2; exit 1; }
[[ -z "$management_interface" || "$management_interface" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$ ]] || { echo "Invalid management interface" >&2; exit 1; }
if [[ -n "$dedicated_ip" && ( -z "$management_interface" || -z "$bind_ip" || -n "$client_ports" ) ]]; then
    echo "Dedicated forwarding requires a management interface and bind IP, without individual client port ranges" >&2
    exit 1
fi
[[ -z "$bind_ip" || -n "$dedicated_ip" ]] || { echo "--bind-ip requires --dedicated-ip" >&2; exit 1; }
python3 - "$control_ip" "$api_port" "$client_ports" "$dedicated_ip" "$bind_ip" "${ssh_port:-22}" <<'PY'
import ipaddress
import sys
try:
    address = ipaddress.IPv4Address(sys.argv[1])
    if address.is_unspecified or address.is_multicast:
        raise ValueError()
    port = int(sys.argv[2])
    ssh_port = int(sys.argv[6])
    if not sys.argv[2].isdigit() or not 1 <= port <= 65535 or port == ssh_port:
        raise ValueError()
    if not sys.argv[6].isdigit() or not 1 <= ssh_port <= 65535:
        raise ValueError()
    if sys.argv[3]:
        start, end = map(int, sys.argv[3].split(':'))
        if not 1 <= start <= end <= 65535 or start <= port <= end or start <= ssh_port <= end:
            raise ValueError()
    for value in sys.argv[4:6]:
        if value:
            address = ipaddress.IPv4Address(value)
            if address.is_unspecified or address.is_multicast or address.is_loopback:
                raise ValueError()
except ValueError:
    sys.exit('Invalid control IP or port range; reserve SSH and the Incus API port')
PY

for command in ip iptables ip6tables; do
    command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
if [[ "$persist" == "true" ]]; then
    if command -v systemctl >/dev/null; then
        init_system=systemd
    elif command -v rc-service >/dev/null && command -v rc-update >/dev/null; then
        init_system=openrc
    else
        echo "Persistence requires systemd or OpenRC" >&2
        exit 1
    fi
fi

uplink=$(ip -4 route show default | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
bridge_cidr=$(ip -o -4 addr show dev "$bridge" | awk 'NR==1 {print $4}')
[[ -n "$uplink" && -n "$bridge_cidr" && "$uplink" != "$bridge" ]] || {
    echo "An IPv4 default route and initialized Incus bridge are required" >&2
    exit 1
}

if [[ -n "$management_interface" ]]; then
    [[ "$management_interface" != "$uplink" && "$management_interface" != "$bridge" ]] || {
        echo "Management must use a separate interface" >&2; exit 1;
    }
    ip -4 route get "$control_ip" | grep -qF " dev ${management_interface} " || {
        echo "The control IP must be reachable through the management interface" >&2; exit 1;
    }
fi
if [[ -n "$dedicated_ip" ]]; then
    python3 - "$bridge_cidr" "$dedicated_ip" <<'PY'
import ipaddress
import sys
bridge = ipaddress.IPv4Interface(sys.argv[1])
guest = ipaddress.IPv4Address(sys.argv[2])
if guest not in bridge.network or guest in (bridge.ip, bridge.network.network_address, bridge.network.broadcast_address):
    sys.exit('Dedicated IP must be a usable guest address inside the bridge subnet')
PY
    ip -o -4 addr show dev "$uplink" | awk -v bind="$bind_ip" '
        { split($4, address, "/"); if (address[1] == bind) found=1 }
        END { exit !found }
    ' || { echo "Bind IP is not assigned to the public uplink" >&2; exit 1; }
fi

configure_oci_rules() {
# Only these Incudal-owned chains are rebuilt. OCI's INPUT/FORWARD policies,
# SSH rules, and the OUTPUT InstanceServices chain are retained.
for chain in INCUDAL_OCI_IN INCUDAL_OCI_FWD; do
    iptables -w -N "$chain" 2>/dev/null || iptables -w -S "$chain" >/dev/null
    iptables -w -F "$chain"
done
iptables -w -A INCUDAL_OCI_IN -i lo -p tcp --dport "$api_port" -j ACCEPT
local control_source=(-s "$control_ip/32")
[[ -z "$management_interface" ]] || control_source+=(-i "$management_interface")
iptables -w -A INCUDAL_OCI_IN "${control_source[@]}" -p tcp --dport "$api_port" -j ACCEPT
if [[ -n "$management_interface" ]]; then
    iptables -w -A INCUDAL_OCI_IN "${control_source[@]}" -p tcp --dport "${ssh_port:-22}" -j ACCEPT
fi
iptables -w -A INCUDAL_OCI_IN -p tcp --dport "$api_port" -j REJECT --reject-with tcp-reset
iptables -w -A INCUDAL_OCI_IN -i "$bridge" -p udp -m multiport --dports 53,67 -j ACCEPT
iptables -w -A INCUDAL_OCI_IN -i "$bridge" -p tcp --dport 53 -j ACCEPT
# A DD-installed Alpine host may have an ACCEPT policy. Guest root must not
# gain access to host SSH or other host services through the bridge gateway.
iptables -w -A INCUDAL_OCI_IN -i "$bridge" -j REJECT --reject-with icmp-admin-prohibited
if [[ -n "$client_ports" ]]; then
    iptables -w -A INCUDAL_OCI_IN -p tcp --dport "$client_ports" -j ACCEPT
    iptables -w -A INCUDAL_OCI_IN -p udp --dport "$client_ports" -j ACCEPT
fi

# Container traffic uses FORWARD, so the OCI host's OUTPUT restrictions do not
# protect instance metadata. Deny that destination before allowing egress.
iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited
if [[ -n "$dedicated_ip" ]]; then
    # Keep the customer away from the OCI VCN and the management overlay.
    local subnet
    for subnet in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
        iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -d "$subnet" -j REJECT --reject-with icmp-admin-prohibited
    done
fi
iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -s "$bridge_cidr" -o "$uplink" -j ACCEPT
iptables -w -A INCUDAL_OCI_FWD -i "$bridge" -j REJECT --reject-with icmp-admin-prohibited
iptables -w -A INCUDAL_OCI_FWD -o "$bridge" -d "$bridge_cidr" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A INCUDAL_OCI_FWD -o "$bridge" -d "$bridge_cidr" -m conntrack --ctstate DNAT -j ACCEPT

for entry in 'INPUT INCUDAL_OCI_IN' 'FORWARD INCUDAL_OCI_FWD'; do
    read -r parent chain <<< "$entry"
    while iptables -w -C "$parent" -j "$chain" 2>/dev/null; do
        iptables -w -D "$parent" -j "$chain"
    done
    iptables -w -I "$parent" 1 -j "$chain"
done

# OCI maps the public address to bind_ip before packets reach this machine.
# NAT runs only for a connection's first packet, preserving replies to the
# host's outbound management tunnel, DNS, and package downloads.
if [[ -n "$dedicated_ip" ]]; then
    iptables -w -t nat -N INCUDAL_OCI_NAT 2>/dev/null || iptables -w -t nat -S INCUDAL_OCI_NAT >/dev/null
    iptables -w -t nat -F INCUDAL_OCI_NAT
    for protocol in tcp udp; do
        iptables -w -t nat -A INCUDAL_OCI_NAT -i "$uplink" -d "$bind_ip/32" -p "$protocol" -j DNAT --to-destination "$dedicated_ip"
    done
    while iptables -w -t nat -C PREROUTING -j INCUDAL_OCI_NAT 2>/dev/null; do
        iptables -w -t nat -D PREROUTING -j INCUDAL_OCI_NAT
    done
    iptables -w -t nat -I PREROUTING 1 -j INCUDAL_OCI_NAT
elif iptables -w -t nat -S INCUDAL_OCI_NAT >/dev/null 2>&1; then
    iptables -w -t nat -F INCUDAL_OCI_NAT
    while iptables -w -t nat -C PREROUTING -j INCUDAL_OCI_NAT 2>/dev/null; do
        iptables -w -t nat -D PREROUTING -j INCUDAL_OCI_NAT
    done
fi

# This deployment uses an IPv4 control address. Do not leave the Incus [::]
# listener publicly reachable if the host later receives an IPv6 address.
ip6tables -w -N INCUDAL_OCI_IN 2>/dev/null || ip6tables -w -S INCUDAL_OCI_IN >/dev/null
ip6tables -w -F INCUDAL_OCI_IN
ip6tables -w -A INCUDAL_OCI_IN -i lo -p tcp --dport "$api_port" -j ACCEPT
ip6tables -w -A INCUDAL_OCI_IN -p tcp --dport "$api_port" -j REJECT --reject-with tcp-reset
ip6tables -w -A INCUDAL_OCI_IN -i "$bridge" -j REJECT --reject-with icmp6-adm-prohibited
while ip6tables -w -C INPUT -j INCUDAL_OCI_IN 2>/dev/null; do
    ip6tables -w -D INPUT -j INCUDAL_OCI_IN
done
ip6tables -w -I INPUT 1 -j INCUDAL_OCI_IN
}

persist_oci_network() {
    local target=/usr/local/sbin/incudal-oci-network
    install -d -m 0755 "$(dirname "$target")"
    if [[ "$(readlink -f "$0")" != "$target" ]]; then
        install -m 0755 "$0" "$target"
    fi
    local arguments="--control-ip ${control_ip} --bridge ${bridge} --api-port ${api_port}"
    arguments+="${client_ports:+ --client-ports ${client_ports}}"
    arguments+="${management_interface:+ --management-interface ${management_interface}}"
    arguments+="${dedicated_ip:+ --dedicated-ip ${dedicated_ip} --bind-ip ${bind_ip}}"
    arguments+=" --ssh-port ${ssh_port:-22}"
    if [[ "$init_system" == openrc ]]; then
        cat > /etc/init.d/incudal-oci-network <<EOF
#!/sbin/openrc-run
description="Incudal networking for OCI IPv4 nodes"

depend() {
    need net incusd
    after firewall iptables ip6tables${management_interface:+ wg-quick.${management_interface}}
    before incudal-agent
}

start() {
    ebegin "Configuring Incudal OCI networking"
    # DHCP, the Incus bridge, and the management route can become ready later
    # than their services. Retry the complete validated, idempotent setup.
    local attempt=0
    while ! ${target} ${arguments}; do
        attempt=\$((attempt + 1))
        if [ "\$attempt" -ge 60 ]; then
            eend 1
            return 1
        fi
        sleep 2
    done
    eend 0
}
EOF
        chmod 0755 /etc/init.d/incudal-oci-network
        rc-update add incudal-oci-network default
        rc-service incudal-oci-network restart
        return
    fi
    cat > /etc/systemd/system/incudal-oci-network.service <<EOF
[Unit]
Description=Incudal networking for OCI IPv4 nodes
Wants=network-online.target
After=network-online.target netfilter-persistent.service incus.service${management_interface:+ wg-quick@${management_interface}.service}
Before=incudal-agent.service

[Service]
Type=oneshot
ExecStart=${target} ${arguments}
RemainAfterExit=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 /etc/systemd/system/incudal-oci-network.service
    systemctl daemon-reload
    systemctl enable --now incudal-oci-network.service
}

configure_oci_rules
if [[ "$persist" == "true" ]]; then
    persist_oci_network
fi

echo "OCI network configured: control=${control_ip}, API=${api_port}, bridge=${bridge}, client_ports=${client_ports:-none}, dedicated_ip=${dedicated_ip:-none}"
