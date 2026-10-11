#!/usr/bin/env python3
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('swap', Path(__file__).with_name('ensure-host-swap.py'))
swap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(swap)


class SwapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='incudal-swap-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, path in {'FSTAB': self.root / 'fstab', 'SWAPS': self.root / 'swaps', 'SWAP_DIRECTORY': self.root / 'incudal', 'LOCK_FILE': self.root / 'lock'}.items():
            p = patch.object(swap, name, path)
            p.start()
            self.addCleanup(p.stop)
        swap.FSTAB.write_text('# fixture\n/dev/vda1 / ext4 defaults 0 1\n')
        swap.SWAPS.write_text('Filename Type Size Used Priority\n/swapfile file 1048572 0 -2\n')

    def test_existing_swap_is_reused_and_persisted_once(self):
        with patch.object(swap.os, 'geteuid', return_value=0), patch.object(swap, 'run') as run, patch.object(swap.shutil, 'which', return_value='/bin/fixture'), contextlib.redirect_stdout(io.StringIO()):
            swap.ensure_swap()
            swap.ensure_swap()
        self.assertEqual(swap.FSTAB.read_text().count('/swapfile none swap defaults 0 0'), 1)
        self.assertIn('/dev/vda1 / ext4 defaults 0 1', swap.FSTAB.read_text())
        self.assertFalse(swap.SWAP_DIRECTORY.exists())
        self.assertFalse(any(call.args[0] in ('swapon', 'mkswap') for call in run.call_args_list))

    def test_larger_existing_swap_is_never_shrunk(self):
        swap.SWAPS.write_text('Filename Type Size Used Priority\n/swapfile file 2097148 0 -2\n')
        with patch.object(swap.os, 'geteuid', return_value=0), patch.object(swap, 'run'), patch.object(swap.shutil, 'which', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            swap.ensure_swap()
        self.assertFalse(swap.SWAP_DIRECTORY.exists())

    def test_noauto_is_removed_and_openrc_boot_service_is_enabled(self):
        swap.FSTAB.write_text('/swapfile none swap sw,noauto 0 0\n')
        with patch.object(swap, 'run') as run, patch.object(swap.shutil, 'which', side_effect=lambda name: '/sbin/rc-update' if name == 'rc-update' else None):
            swap.persist(['/swapfile'])
        self.assertNotIn('noauto', swap.FSTAB.read_text())
        self.assertEqual(swap.FSTAB.read_text().count('/swapfile'), 1)
        run.assert_called_once_with('rc-update', 'add', 'swap', 'boot')

    def test_zram_does_not_replace_disk_swap_and_paths_roundtrip(self):
        swap.SWAPS.write_text('Filename Type Size Used Priority\n/dev/zram0 partition 2097148 0 100\n')
        self.assertEqual(swap.swaps(), [])
        path = '/some path/with\\slash'
        self.assertEqual(swap.unescape(swap.escape(path)), path)

    def test_existing_symlink_is_never_followed(self):
        swap.SWAPS.write_text('Filename Type Size Used Priority\n')
        swap.SWAP_DIRECTORY.mkdir()
        (swap.SWAP_DIRECTORY / 'swapfile').symlink_to(self.root / 'unrelated')
        with patch.object(swap.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                swap.ensure_swap()


if __name__ == '__main__':
    unittest.main()
