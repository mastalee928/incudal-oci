#!/usr/bin/env python3
"""Packet-level checks; this script must run inside `unshare --net`."""
import os
import pathlib
import subprocess
import sys
import time

if os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
    raise SystemExit('Refusing to modify the host network namespace')

processes = []


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def ns(pid, *args):
    return run('nsenter', '-t', str(pid), '-n', *args)


def namespace():
    process = subprocess.Popen(['unshare', '--net', 'sleep', '60'])
    processes.append(process)
    for _ in range(100):
        if os.readlink('/proc/self/ns/net') != os.readlink(f'/proc/{process.pid}/ns/net'):
            return process.pid
        time.sleep(0.01)
    raise RuntimeError('Could not create test namespace')


ECHO = r'''
import socket, threading, sys, time
def serve(address, port, tcp):
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM)
    if family == socket.AF_INET6: s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((address, port))
    if tcp:
        s.listen()
        while True:
            conn, _ = s.accept()
            data = conn.recv(1024); conn.sendall(data); conn.close()
    else:
        while True:
            data, source = s.recvfrom(1024); s.sendto(data, source)
for address in ['0.0.0.0', '::']:
    for port in [53, 9000, 51820]:
        for tcp in [False, True]:
            threading.Thread(target=serve, args=(address, port, tcp), daemon=True).start()
print('ready', flush=True)
time.sleep(60)
'''

PROBE = r'''
import socket, sys
address, port, protocol, source_port = sys.argv[1:]
family = socket.AF_INET6 if ':' in address else socket.AF_INET
s = socket.socket(family, socket.SOCK_STREAM if protocol == 'tcp' else socket.SOCK_DGRAM)
s.settimeout(0.8)
if protocol == 'udp': s.bind(('::' if family == socket.AF_INET6 else '0.0.0.0', int(source_port)))
try:
    s.connect((address, int(port))); s.send(b'incudal-probe')
    print('open' if s.recv(1024) == b'incudal-probe' else 'wrong')
except socket.timeout:
    print('blocked')
finally:
    s.close()
'''


def start_echo(pid=None):
    prefix = ['nsenter', '-t', str(pid), '-n'] if pid else []
    process = subprocess.Popen(prefix + ['python3', '-u', '-c', ECHO], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    processes.append(process)
    assert process.stdout.readline().strip() == 'ready'


def probe(pid, address, port, protocol, expected, source_port=40001):
    result = ns(pid, 'python3', '-c', PROBE, address, str(port), protocol, str(source_port)).stdout.strip()
    if result != expected:
        print(run('ip', '-6', 'addr').stdout, run('ip', '-6', 'route').stdout, flush=True)
        print(ns(pid, 'ip', '-6', 'neigh').stdout, run('nft', 'list', 'ruleset').stdout, flush=True)
    assert result == expected, f'{protocol} {address}:{port}: expected {expected}, got {result}'


def apply(path, exists=True):
    rules = pathlib.Path(path).read_text()
    if exists:
        rules = 'delete table inet incudal_ingress_protocol\n' + rules
    run('nft', '-f', '-', input=rules)


try:
    # Restored rules must also load before the Incus bridge exists at boot.
    apply(sys.argv[1], exists=False)
    run('ip', 'link', 'set', 'lo', 'up')
    pathlib.Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
    pathlib.Path('/proc/sys/net/ipv6/conf/all/forwarding').write_text('1')
    pathlib.Path('/proc/sys/net/ipv6/conf/default/forwarding').write_text('1')
    client, guest = namespace(), namespace()
    run('ip', 'link', 'add', 'uplink', 'type', 'veth', 'peer', 'name', 'client0')
    run('ip', 'link', 'set', 'client0', 'netns', str(client))
    run('ip', 'link', 'add', 'incusbr0', 'type', 'bridge')
    run('ip', 'link', 'add', 'guest-link', 'type', 'veth', 'peer', 'name', 'guest0')
    run('ip', 'link', 'set', 'guest0', 'netns', str(guest))
    run('ip', 'link', 'set', 'guest-link', 'master', 'incusbr0')
    for interface in ['uplink', 'incusbr0', 'guest-link']:
        run('ip', 'link', 'set', interface, 'up')
    for interface, v4, v6 in [('uplink', '172.28.0.1/24', 'fd42:1::1/64'), ('incusbr0', '10.10.0.1/24', 'fd42:2::1/64')]:
        run('ip', 'addr', 'add', v4, 'dev', interface)
        run('ip', '-6', 'addr', 'add', v6, 'dev', interface, 'nodad')
    for pid, interface, v4, v6, gateway4, gateway6 in [
        (client, 'client0', '172.28.0.2/24', 'fd42:1::2/64', '172.28.0.1', 'fd42:1::1'),
        (guest, 'guest0', '10.10.0.2/24', 'fd42:2::2/64', '10.10.0.1', 'fd42:2::1')]:
        ns(pid, 'ip', 'link', 'set', 'lo', 'up')
        ns(pid, 'ip', 'link', 'set', interface, 'up')
        ns(pid, 'ip', 'addr', 'add', v4, 'dev', interface)
        ns(pid, 'ip', '-6', 'addr', 'add', v6, 'dev', interface, 'nodad')
        ns(pid, 'ip', 'route', 'add', 'default', 'via', gateway4)
        ns(pid, 'ip', '-6', 'route', 'add', 'default', 'via', gateway6)
    start_echo(client); start_echo(guest); start_echo()
    # Let newly created link-local addresses finish IPv6 duplicate detection.
    time.sleep(2)
    run('nft', 'add', 'table', 'inet', 'unrelated_test_table')
    apply(sys.argv[2])
    for address in ['10.10.0.2', 'fd42:2::2', 'fd42:1::1']:
        probe(client, address, 9000, 'udp', 'open')
    apply(sys.argv[1])
    for address in ['10.10.0.2', 'fd42:2::2', 'fd42:1::1']:
        probe(client, address, 9000, 'udp', 'blocked')
        probe(client, address, 9000, 'tcp', 'open')
    probe(guest, '172.28.0.2', 53, 'udp', 'open', 40002)
    probe(guest, 'fd42:1::2', 53, 'udp', 'open', 40002)
    probe(guest, '10.10.0.1', 53, 'udp', 'open', 40003)
    probe(client, '172.28.0.1', 51820, 'udp', 'open', 40004)
    run('nft', 'delete', 'table', 'inet', 'incudal_ingress_protocol')
    apply(sys.argv[1], exists=False)
    probe(client, '10.10.0.2', 9000, 'udp', 'blocked')
    apply(sys.argv[2])
    for address in ['10.10.0.2', 'fd42:2::2', 'fd42:1::1']:
        probe(client, address, 9000, 'udp', 'open')
    run('nft', 'list', 'table', 'inet', 'unrelated_test_table')
    print('IPv4/IPv6 ingress, existing UDP flows, IPv6 proxy, TCP, outbound DNS, host DNS, management UDP, restore and re-enable passed')
finally:
    for process in reversed(processes):
        process.terminate()
    for process in reversed(processes):
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
