#!/usr/bin/env python3
"""Unit tests use temporary state and fake Docker/systemd; never touch a deployment."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('panel-updater.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
SHA = 'a' * 40
OLD_SHA = 'b' * 40


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='incudal-updater-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'directory': str(self.root), 'repository': 'fixture/project', 'project': 'fixture', 'files': [], 'appUid': 1001, 'appGid': 1001}
        self.override = {'services': {'app': {'image': 'fixture:old'}}}
        for name, value in {'STATE_DIR': self.root, 'STATUS_FILE': self.root / 'status.json', 'CONFIG_FILE': self.root / 'config.json', 'OVERRIDE': self.root / 'compose.json'}.items():
            p = patch.object(updater, name, value)
            p.start()
            self.addCleanup(p.stop)
        updater.write_json(updater.CONFIG_FILE, self.config)
        updater.write_json(updater.OVERRIDE, self.override)

    def request(self, **changes):
        return {'action': 'apply', 'id': str(uuid4()), 'commit': SHA, 'repository': self.config['repository'], **changes}

    def queue(self):
        with patch.object(updater, 'run', return_value=''):
            return updater.dispatch(self.request(), self.config)['execution']

    def test_rpc_only_accepts_status_or_pinned_repo_apply(self):
        updater.validate_request({'action': 'status'}, self.config)
        for value in [self.request(command='id'), self.request(commit='main'), self.request(commit='a' * 40 + ';id'),
                      self.request(repository='attacker/project'), {'action': 'shell'}, self.request(id='../config'), [], None]:
            with self.assertRaises(updater.UpdateFailure):
                updater.validate_request(value, self.config)

    def test_queue_is_durable_idempotent_and_exclusive(self):
        request = self.request()
        with patch.object(updater, 'run') as run:
            first = updater.dispatch(request, self.config)
            self.assertEqual(updater.dispatch(request, self.config), first)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(updater.dispatch({'action': 'status'}, self.config)['execution']['id'], request['id'])
            with self.assertRaisesRegex(updater.UpdateFailure, 'UPDATE_IN_PROGRESS'):
                updater.dispatch(self.request(), self.config)

    def test_ci_must_pass_for_main_push_and_exact_commit(self):
        passed = {'id': 1, 'head_sha': SHA, 'head_branch': 'main', 'event': 'push', 'status': 'completed', 'conclusion': 'success'}
        with patch.object(updater, 'github', side_effect=[{'sha': SHA}, {'workflow_runs': [passed]}]):
            updater.verify_target(self.config, SHA)
        for invalid in [{**passed, 'head_sha': OLD_SHA}, {**passed, 'event': 'pull_request'}, {**passed, 'conclusion': 'failure'}]:
            with patch.object(updater, 'github', side_effect=[{'sha': SHA}, {'workflow_runs': [invalid]}]):
                with self.assertRaisesRegex(updater.UpdateFailure, 'UPDATE_CI_NOT_PASSED'):
                    updater.verify_target(self.config, SHA)
        with patch.object(updater, 'github', return_value={'sha': OLD_SHA}):
            with self.assertRaisesRegex(updater.UpdateFailure, 'UPDATE_TARGET_CHANGED'):
                updater.verify_target(self.config, SHA)

    def test_running_oneshot_service_is_activating_and_not_interrupted(self):
        state = self.queue()
        state['startedAt'] = '2020-01-01T00:00:00+00:00'
        updater.write_json(updater.STATUS_FILE, state)
        with patch.object(updater, 'run', return_value='activating'):
            self.assertEqual(updater.dispatch({'action': 'status'}, self.config)['execution']['status'], 'running')
        with patch.object(updater, 'run', return_value='failed'):
            result = updater.dispatch({'action': 'status'}, self.config)
            self.assertEqual(result['execution']['error'], 'UPDATE_INTERRUPTED')

    @unittest.skipUnless(shutil.which('git'), 'Git is required for worktree permissions')
    def test_source_worktree_is_readable_without_exposing_private_state(self):
        (self.root / '.env').write_text('')
        (self.root / '.gitignore').write_text('.env\nconfig.json\ncompose.json\n')
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'package.json').write_text('{}')
        for args in [['init'], ['add', '.gitignore', 'server'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']]:
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        stage = self.root / 'build'
        previous = os.umask(0o077)
        try:
            updater.git(self.config, 'worktree', 'add', '--detach', str(stage), 'HEAD')
            self.assertEqual((stage / 'server' / 'package.json').stat().st_mode & 0o777, 0o644)
            self.assertEqual((stage / 'server').stat().st_mode & 0o777, 0o755)
            updater.write_json(updater.STATUS_FILE, {'private': True})
            self.assertEqual(updater.STATUS_FILE.stat().st_mode & 0o777, 0o600)
        finally:
            os.umask(previous)

    def test_socket_is_accessible_to_app_group_under_restrictive_service_umask(self):
        socket_dir = self.root / 'run'
        socket_file = socket_dir / 'updater.sock'
        self.config['appUid'] = os.getuid()
        self.config['appGid'] = os.getgid()
        updater.write_json(updater.CONFIG_FILE, self.config)
        errors = []
        def serve():
            try:
                updater.serve()
            except Exception as error:
                errors.append(error)
        previous = os.umask(0o077)
        try:
            with patch.object(updater, 'SOCKET_DIR', socket_dir), patch.object(updater, 'SOCKET_FILE', socket_file), \
                    patch.object(updater.os, 'chown'), patch.object(updater.socketserver.ThreadingUnixStreamServer, 'serve_forever', lambda server: server.handle_request()):
                worker = threading.Thread(target=serve, daemon=True)
                worker.start()
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and (not socket_file.exists() or socket_file.stat().st_mode & 0o777 != 0o660):
                    time.sleep(0.01)
                self.assertEqual(socket_dir.stat().st_mode & 0o777, 0o750)
                self.assertEqual(socket_file.stat().st_mode & 0o777, 0o660)
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(3)
                    client.connect(str(socket_file))
                    client.sendall(b'{"action":"status"}\n')
                    response = json.loads(client.recv(65536))
                    self.assertEqual(response['protocol'], 1)
                    self.assertEqual(response['sourceRepository'], self.config['repository'])
                worker.join(timeout=3)
                self.assertFalse(worker.is_alive())
                self.assertFalse(errors)
        finally:
            os.umask(previous)

    def pipeline(self, healthy=True, dirty=False, backup_failure=False):
        state = self.queue()
        calls = []
        def git(_config, *args, **kwargs):
            calls.append(('git', *args))
            if args[:2] == ('rev-parse', 'HEAD'):
                return OLD_SHA
            if args[:2] == ('rev-parse', 'FETCH_HEAD'):
                return SHA
            return ''
        def compose(_config, *args, **kwargs):
            calls.append(('compose', *args))
            if args[:2] == ('ps', '-q'):
                return 'fixture-container'
            if kwargs.get('stdout'):
                if backup_failure:
                    raise updater.UpdateFailure('UPDATE_BACKUP_FAILED')
                kwargs['stdout'].write(b'fixture-dump' * 32)
            return ''
        def run(args, **kwargs):
            calls.append(tuple(args))
            if args[:2] == ['docker', 'inspect']:
                return OLD_SHA if 'revision' in args[3] else 'sha256:' + OLD_SHA
            return ''
        with patch.object(updater, 'verify_target'), patch.object(updater, 'require_clean', side_effect=updater.UpdateFailure('UPDATE_WORKTREE_DIRTY') if dirty else None), \
                patch.object(updater, 'git', side_effect=git), patch.object(updater, 'compose', side_effect=compose), patch.object(updater, 'run', side_effect=run), \
                patch.object(updater, 'wait_healthy', side_effect=[healthy, True]):
            updater.execute(state['id'])
        return updater.read_json(updater.STATUS_FILE), calls

    def test_dirty_checkout_does_not_stop_or_build_the_app(self):
        state, calls = self.pipeline(dirty=True)
        self.assertEqual(state['error'], 'UPDATE_WORKTREE_DIRTY')
        self.assertFalse(calls)

    def test_backup_precedes_switch_and_build_pins_exact_commit(self):
        state, calls = self.pipeline()
        self.assertEqual(state['status'], 'succeeded')
        build = next(c for c in calls if c[:2] == ('docker', 'build'))
        self.assertIn('INCUDAL_COMMIT=' + SHA, build)
        backup = next(i for i, c in enumerate(calls) if 'pg_dump' in ' '.join(c))
        switch = next(i for i, c in enumerate(calls) if c[:3] == ('git', 'checkout', '--detach'))
        self.assertLess(backup, switch)
        self.assertEqual(updater.read_json(updater.OVERRIDE)['services']['app']['image'], 'incudal-panel:' + SHA)

    def test_failed_start_restores_old_image_without_database_restore(self):
        state, calls = self.pipeline(healthy=False)
        self.assertEqual(state['status'], 'failed')
        self.assertEqual(state['error'], 'UPDATE_HEALTH_FAILED')
        self.assertTrue(state['rollbackSucceeded'])
        self.assertTrue(updater.read_json(updater.OVERRIDE)['services']['app']['image'].startswith('incudal-panel:rollback-'))
        self.assertFalse(any('pg_restore' in ' '.join(c) for c in calls))

    def test_backup_failure_prevents_new_version_start(self):
        state, calls = self.pipeline(backup_failure=True)
        self.assertEqual(state['error'], 'UPDATE_BACKUP_FAILED')
        self.assertFalse(any(c == ('git', 'checkout', '--detach', SHA) for c in calls))


if __name__ == '__main__':
    unittest.main()
