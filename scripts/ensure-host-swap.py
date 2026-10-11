#!/usr/bin/env python3
"""Ensure >= 1 GiB disk-backed swap, preserving existing swap and boot config."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SIZE = 1024 ** 3
FSTAB = Path('/etc/fstab')
SWAPS = Path('/proc/swaps')
SWAP_DIRECTORY = Path('/var/lib/incudal')
LOCK_FILE = Path('/run/incudal-swap.lock')


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def unescape(value):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), value)


def escape(value):
    return value.replace('\\', '\\134').replace(' ', '\\040').replace('\t', '\\011')


def swaps():
    result = []
    for line in SWAPS.read_text().splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 3 and not fields[0].startswith('/dev/zram'):
            result.append((unescape(fields[0]), int(fields[2]) * 1024))
    return result


def persist(paths):
    fstab = FSTAB
    lines = fstab.read_text().splitlines() if fstab.exists() else []
    missing = set(paths)
    for index, line in enumerate(lines):
        fields = line.split()
        if len(fields) < 4 or fields[0].startswith('#') or fields[2] != 'swap':
            continue
        source = unescape(fields[0])
        if source not in missing and (source.startswith('UUID=') or source.startswith('LABEL=')):
            try:
                source = run('findfs', source)
            except (OSError, subprocess.CalledProcessError):
                continue
        if source in missing:
            missing.remove(source)
            if 'noauto' in fields[3].split(','):
                fields[3] = ','.join(x for x in fields[3].split(',') if x != 'noauto') or 'defaults'
                lines[index] = '\t'.join(fields)
    lines.extend(f'{escape(path)} none swap defaults 0 0' for path in sorted(missing))
    content = '\n'.join(lines) + '\n'
    if not fstab.exists() or content != fstab.read_text():
        metadata = fstab.stat() if fstab.exists() else None
        fd, temp = tempfile.mkstemp(prefix='.incudal-fstab-', dir=fstab.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchmod(stream.fileno(), metadata.st_mode & 0o777 if metadata else 0o644)
            os.replace(temp, fstab)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    if shutil.which('systemctl'):
        run('systemctl', 'daemon-reload')
    elif shutil.which('rc-update'):
        run('rc-update', 'add', 'swap', 'boot')


def ensure_swap():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    with open(LOCK_FILE, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = swaps()
        if sum(size for _, size in current) < SIZE - 1024 ** 2:
            directory = SWAP_DIRECTORY
            if directory.is_symlink():
                raise RuntimeError('swap directory is a symlink')
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            target = directory / 'swapfile'
            if target.is_symlink():
                raise RuntimeError('swap file is a symlink')
            if target.exists():
                if not target.is_file() or target.stat().st_size != SIZE or run('blkid', '-p', '-s', 'TYPE', '-o', 'value', str(target)) != 'swap':
                    raise RuntimeError('existing swap file is not managed swap')
            else:
                temp = directory / 'swapfile.preparing'
                if temp.is_symlink():
                    raise RuntimeError('swap temporary file is a symlink')
                # Only this private temporary name is recoverable after an interrupted creation.
                if temp.exists():
                    temp.unlink()
                try:
                    filesystem = run('stat', '-f', '-c', '%T', str(directory))
                    if filesystem == 'btrfs':
                        run('btrfs', 'filesystem', 'mkswapfile', '--size', str(SIZE), str(temp))
                    else:
                        with open(temp, 'xb') as stream:
                            os.fchmod(stream.fileno(), 0o600)
                            block = bytes(1024 ** 2)
                            for _ in range(1024):
                                stream.write(block)
                            stream.flush()
                            os.fsync(stream.fileno())
                        run('mkswap', str(temp))
                    temp.chmod(0o600)
                    os.replace(temp, target)
                finally:
                    if temp.exists():
                        temp.unlink()
            if str(target) not in dict(current):
                run('swapon', str(target))
            current = swaps()
        if sum(size for _, size in current) < SIZE - 1024 ** 2:
            raise RuntimeError('swap activation failed')
        persist([path for path, _ in current])
        print('INCUDAL_SWAP:' + json.dumps({'diskSwapMiB': sum(size for _, size in current) // 1024 ** 2}))


if __name__ == '__main__':
    try:
        ensure_swap()
    except Exception:
        # Keep host paths and command output out of the API error response.
        print('INCUDAL_ERROR:HOST_SWAP_FAILED')
        raise SystemExit(1)
