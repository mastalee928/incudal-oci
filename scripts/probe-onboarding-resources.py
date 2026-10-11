#!/usr/bin/env python3
"""Read physical resources before creating the Incus pool; stdout is bounded JSON."""
import json
import os
import platform
from pathlib import Path

memory = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    memory[key] = int(value.strip().split()[0])
path = Path('/var/lib/incus')
while not path.exists():
    path = path.parent
disk = os.statvfs(path)
swap_kib = 0
for line in Path('/proc/swaps').read_text().splitlines()[1:]:
    fields = line.split()
    if len(fields) >= 3 and not fields[0].startswith('/dev/zram'):
        swap_kib += int(fields[2])
print(json.dumps({
    'architecture': platform.machine(),
    'cpuCount': os.cpu_count(),
    'memoryMiB': memory['MemTotal'] // 1024,
    'diskTotalBytes': str(disk.f_blocks * disk.f_frsize),
    'diskAvailableBytes': str(disk.f_bavail * disk.f_frsize),
    'diskSwapMiB': swap_kib // 1024,
}))
