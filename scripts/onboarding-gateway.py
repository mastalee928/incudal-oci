#!/usr/bin/env python3
"""Restricted SSH forced-command helper for the Incudal management gateway.

Authorize a dedicated key with:
restrict,command="/usr/local/sbin/incudal-onboarding-gateway" ssh-ed25519 ...
Only status and idempotent peer registration are supported.
"""
import fcntl
import ipaddress
import json
import os
import pathlib
import re
import shlex
import subprocess
import tempfile

INTERFACE = "incudal-mgmt"
CONFIG = pathlib.Path("/etc/wireguard") / (INTERFACE + ".conf")
STATE = pathlib.Path("/var/lib/incudal-onboarding")
MANAGEMENT_PUBLIC_KEY = pathlib.Path("/root/.ssh/incudal-host-management.pub")


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def atomic_write(path, content):
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def ipv4_networks(value):
    return [network for item in re.split(r"[\s,]+", value.strip()) if item and item != "(none)"
            for network in [ipaddress.ip_network(item)] if network.version == 4]


def configured_peers(config):
    peers = {}
    for section in re.split(r"(?m)^\s*\[Peer\]\s*$", config)[1:]:
        fields = {}
        for line in section.splitlines():
            line = line.split("#", 1)[0].strip()
            if line.startswith("["):
                break
            if "=" in line:
                key, value = line.split("=", 1)
                fields[key.strip()] = value.strip()
        if fields.get("PublicKey"):
            key = fields["PublicKey"]
            if key in peers:
                raise ValueError("duplicate configured peer")
            peers[key] = ipv4_networks(fields.get("AllowedIPs", ""))
    return peers


def register_peer(job, public_key, control, config, live_peers):
    peer_file = STATE / (job + ".json")
    peers = configured_peers(config)
    for key, subnets in live_peers.items():
        peers.setdefault(key, []).extend(subnets)
    reservations = {}
    for path in STATE.glob("*.json"):
        saved = json.loads(path.read_text())
        reservations[path.stem] = saved
        if path != peer_file and saved["nodePublicKey"] == public_key:
            raise ValueError("peer key already registered")
    occupied = [subnet for key, subnets in peers.items() if key != public_key for subnet in subnets]
    occupied.extend(ipaddress.ip_network(saved["managementIp"] + "/32")
                    for key, saved in reservations.items() if key != job)
    if job in reservations:
        saved = reservations[job]
        if saved["nodePublicKey"] != public_key:
            raise ValueError("peer key changed")
        target = ipaddress.ip_address(saved["managementIp"])
        if target not in control.network or target in (control.ip, control.network.network_address, control.network.broadcast_address):
            raise ValueError("invalid reserved address")
        if any(target in subnet for subnet in occupied):
            raise ValueError("peer address is occupied")
    else:
        if public_key in peers:
            raise ValueError("peer already belongs to another registration")
        target = next((ip for ip in control.network.hosts() if ip != control.ip and not any(ip in net for net in occupied)), None)
        if target is None:
            raise ValueError("management network full")
    marker = "# incudal-onboarding " + job
    block = marker + "\n[Peer]\nPublicKey = " + public_key + "\nAllowedIPs = " + str(target) + "/32\n"
    if marker in config and block not in config:
        raise ValueError("registered configuration changed")
    # Reserve durably before changing WireGuard. A crash at any later step can
    # resume this same address, even if the peer is absent from the live device.
    atomic_write(peer_file, json.dumps({"managementIp": str(target), "nodePublicKey": public_key}))
    if marker not in config:
        atomic_write(CONFIG, config.rstrip() + "\n\n" + block)
    run("wg", "set", INTERFACE, "peer", public_key, "allowed-ips", str(target) + "/32")
    return str(target)


def main():
    os.umask(0o077)
    args = shlex.split(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    if args != ["status"] and not (len(args) == 3 and args[0] == "add" and re.fullmatch(r"[a-f0-9-]{36}", args[1]) and re.fullmatch(r"[A-Za-z0-9+/]{43}=", args[2])):
        raise ValueError("unsupported operation")
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(STATE / "lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        addresses = json.loads(run("ip", "-j", "-4", "addr", "show", "dev", INTERFACE))[0]["addr_info"]
        address = next(a for a in addresses if a["family"] == "inet")
        control = ipaddress.ip_interface(str(address["local"]) + "/" + str(address["prefixlen"]))
        if not control.ip in ipaddress.ip_network("10.0.0.0/8") or not 16 <= control.network.prefixlen <= 30:
            raise ValueError("unsupported management network")
        public_key_parts = MANAGEMENT_PUBLIC_KEY.read_text().split()
        if len(public_key_parts) < 2 or public_key_parts[0] != "ssh-ed25519" or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", public_key_parts[1]):
            raise ValueError("management public key missing")
        result = {"publicKey": run("wg", "show", INTERFACE, "public-key"), "controlIp": str(control.ip),
                  "network": str(control.network), "managementSshPublicKey": " ".join(public_key_parts[:2])}
        if args[0] == "add":
            job, public_key = args[1:]
            peers = {}
            for line in run("wg", "show", INTERFACE, "allowed-ips").splitlines():
                fields = line.split(maxsplit=1)
                if len(fields) > 1:
                    peers[fields[0]] = ipv4_networks(fields[1])
            result["managementIp"] = register_peer(job, public_key, control, CONFIG.read_text(), peers)
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print configuration, private keys, or raw command output.
        print('{"error":"gateway operation failed"}')
        raise SystemExit(1)
