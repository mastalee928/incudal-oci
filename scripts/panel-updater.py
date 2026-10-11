#!/usr/bin/env python3
"""Host-side updater for source Compose installs. The panel gets a narrow Unix RPC.

No Docker socket, shell, filesystem path or arbitrary command is exposed to the
panel. A separate systemd job survives app/container restarts. Public status only
contains phase codes; command output and environment secrets are never returned.
"""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

CONFIG_DIR = Path('/etc/incudal-updater')
CONFIG_FILE = CONFIG_DIR / 'config.json'
OVERRIDE = CONFIG_DIR / 'compose.json'
STATE_DIR = Path('/var/lib/incudal-updater')
STATUS_FILE = STATE_DIR / 'status.json'
SOCKET_DIR = Path('/run/incudal-updater')
SOCKET_FILE = SOCKET_DIR / 'updater.sock'
EXECUTOR = Path('/usr/local/libexec/incudal-updater.py')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
JOB = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\Z')
REPOSITORY = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z')


class UpdateFailure(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.updater-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def run(args, cwd=None, timeout=120, stdout=None, extra_env=None, umask=-1):
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'HOME': '/root', 'LANG': 'C.UTF-8', **(extra_env or {})}
    try:
        result = subprocess.run(args, cwd=cwd, env=env, timeout=timeout, check=True, umask=umask,
                                stdout=stdout if stdout is not None else subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        return result.stdout.decode().strip() if result.stdout else ''
    except (OSError, subprocess.SubprocessError):
        raise UpdateFailure('UPDATE_COMMAND_FAILED') from None


def env_value(config, name):
    # Only a token is read; .env is never executed as shell code.
    for line in reversed((Path(config['directory']) / '.env').read_text().splitlines()):
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    return ''


def github(config, path):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'Incudal-Host-Updater'}
    token = env_value(config, 'INCUDAL_UPDATE_GITHUB_TOKEN')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    # Refuse redirects so credentials cannot follow a repository redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    request = urllib.request.Request('https://api.github.com/repos/' + config['repository'] + '/' + path, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            return json.loads(response.read(2 * 1024 * 1024))
    except Exception:
        raise UpdateFailure('UPDATE_CHECK_FAILED') from None


def verify_target(config, commit):
    if not COMMIT.fullmatch(commit):
        raise UpdateFailure('UPDATE_TARGET_INVALID')
    if github(config, 'commits/main').get('sha') != commit:
        raise UpdateFailure('UPDATE_TARGET_CHANGED')
    data = github(config, 'actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=' + commit + '&per_page=20')
    runs = sorted((r for r in data.get('workflow_runs', []) if r.get('head_sha') == commit and
                   r.get('head_branch') == 'main' and r.get('event') == 'push'), key=lambda r: (r.get('id', 0), r.get('run_attempt', 0)), reverse=True)
    if not runs or runs[0].get('status') != 'completed' or runs[0].get('conclusion') != 'success':
        raise UpdateFailure('UPDATE_CI_NOT_PASSED')


def compose(config, *args, **kwargs):
    command = ['docker', 'compose', '--project-directory', config['directory'], '--project-name', config['project'],
               '--env-file', str(Path(config['directory']) / '.env')]
    for file in config['files'] + [str(OVERRIDE)]:
        command += ['-f', file]
    return run(command + list(args), cwd=config['directory'], **kwargs)


def git(config, *args, **kwargs):
    extra_env = {'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    token = env_value(config, 'INCUDAL_UPDATE_GITHUB_TOKEN')
    if token:
        extra_env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
                          'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode()})
    # Source files copied into images must remain readable by the app's UID.
    # Keep the daemon's restrictive umask for state, backups and credentials.
    return run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-C', config['directory'], *args], extra_env=extra_env, umask=0o022, **kwargs)


def require_clean(config):
    if git(config, 'status', '--porcelain', '--untracked-files=normal'):
        raise UpdateFailure('UPDATE_WORKTREE_DIRTY')


def phase(state, value):
    state['phase'] = value
    state['output'] = (state['output'] + now() + ' ' + value + '\n')[-16000:]
    write_json(STATUS_FILE, state)


def healthy(config, commit=None):
    script = "const r=await fetch('http://127.0.0.1:3000/api/health'); if(!r.ok||(await r.json()).status!=='ok')process.exit(1);"
    if commit:
        script += "if(JSON.parse((await import('node:fs')).readFileSync('/app/server/build-info.json','utf8')).commit!==process.argv[1])process.exit(2);"
    try:
        compose(config, 'exec', '-T', 'app', 'node', '--input-type=module', '-e', script, *([commit] if commit else []), timeout=15)
        return True
    except UpdateFailure:
        return False


def wait_healthy(config, commit=None, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if healthy(config, commit):
            return True
        time.sleep(3)
    return False


def execute(job_id):
    config = read_json(CONFIG_FILE)
    state = read_json(STATUS_FILE)
    if not JOB.fullmatch(job_id) or not state or state['id'] != job_id or state['status'] != 'running':
        raise UpdateFailure('UPDATE_TARGET_INVALID')
    commit = state['targetCommit']
    with open(STATE_DIR / 'execution.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = STATE_DIR / ('build-' + job_id)
        previous_override = read_json(OVERRIDE)
        stopped = False
        previous_checkout = None
        try:
            phase(state, 'checking')
            verify_target(config, commit)
            require_clean(config)
            previous_checkout = git(config, 'rev-parse', 'HEAD')
            if shutil.disk_usage(STATE_DIR).free < 2 * 1024 ** 3:
                raise UpdateFailure('UPDATE_DISK_INSUFFICIENT')
            phase(state, 'fetching')
            git(config, 'fetch', '--no-tags', 'https://github.com/' + config['repository'] + '.git', commit, timeout=300)
            if git(config, 'rev-parse', 'FETCH_HEAD') != commit:
                raise UpdateFailure('UPDATE_TARGET_INVALID')
            git(config, 'worktree', 'add', '--detach', str(stage), commit)
            phase(state, 'building')
            image = 'incudal-panel:' + commit
            run(['docker', 'build', '--build-arg', 'INCUDAL_COMMIT=' + commit, '--tag', image, str(stage)], timeout=3600, stdout=subprocess.DEVNULL)
            # Recheck local edits before stopping anything, after the potentially long build.
            require_clean(config)
            container = compose(config, 'ps', '-q', 'app')
            if not container:
                raise UpdateFailure('UPDATE_APP_NOT_RUNNING')
            previous_image = run(['docker', 'inspect', '--format', '{{.Image}}', container])
            rollback_image = 'incudal-panel:rollback-' + job_id
            run(['docker', 'tag', previous_image, rollback_image])
            previous_override['services']['app']['image'] = rollback_image
            running_commit = run(['docker', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', container])
            state['previousCommit'] = running_commit if COMMIT.fullmatch(running_commit) else None
            phase(state, 'backup')
            # Stop writers before the backup; never replace or restore the database automatically.
            stopped = True
            compose(config, 'stop', '-t', '60', 'app', timeout=90)
            backup = STATE_DIR / ('database-' + job_id + '.dump')
            with open(backup, 'xb') as stream:
                compose(config, 'exec', '-T', 'db', 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc', stdout=stream, timeout=600)
                stream.flush()
                os.fsync(stream.fileno())
            if backup.stat().st_size < 64:
                raise UpdateFailure('UPDATE_BACKUP_FAILED')
            phase(state, 'restarting')
            git(config, 'checkout', '--detach', commit)
            override = read_json(OVERRIDE)
            override['services']['app']['image'] = image
            write_json(OVERRIDE, override)
            compose(config, 'up', '-d', '--no-deps', '--no-build', 'app', timeout=180)
            phase(state, 'verifying')
            if not wait_healthy(config, commit):
                raise UpdateFailure('UPDATE_HEALTH_FAILED')
            phase(state, 'updating_executor')
            run(['/usr/bin/python3', str(Path(config['directory']) / 'scripts/panel-updater.py'), 'install',
                 '--project-dir', config['directory'], '--repository', config['repository'],
                 '--app-uid', str(config['appUid']), '--app-gid', str(config['appGid'])], timeout=60)
            state['status'] = 'succeeded'
            state['finishedAt'] = now()
            state['exitCode'] = 0
            phase(state, 'done')
        except Exception as error:
            state['error'] = str(error) if isinstance(error, UpdateFailure) else 'UPDATE_COMMAND_FAILED'
            if stopped:
                phase(state, 'recovering')
                try:
                    # Schema migrations remain in place. DB restore needs an explicit operator decision.
                    compose(config, 'stop', '-t', '30', 'app', timeout=60)
                    if previous_checkout:
                        git(config, 'checkout', '--detach', previous_checkout)
                    write_json(OVERRIDE, previous_override)
                    compose(config, 'up', '-d', '--no-deps', '--no-build', 'app', timeout=180)
                    state['rollbackSucceeded'] = wait_healthy(config, state['previousCommit'], seconds=90)
                except Exception:
                    state['rollbackSucceeded'] = False
            state['status'] = 'failed'
            state['finishedAt'] = now()
            state['exitCode'] = 1
            phase(state, 'failed')
        finally:
            if stage.exists():
                try:
                    git(config, 'worktree', 'remove', str(stage), timeout=120)
                except UpdateFailure:
                    pass


def validate_request(request, config):
    if not isinstance(request, dict):
        raise UpdateFailure('UPDATE_REQUEST_INVALID')
    if request == {'action': 'status'}:
        return
    if set(request) != {'action', 'id', 'commit', 'repository'} or request.get('action') != 'apply':
        raise UpdateFailure('UPDATE_REQUEST_INVALID')
    if not isinstance(request['id'], str) or not JOB.fullmatch(request['id']) or not isinstance(request['commit'], str) or not COMMIT.fullmatch(request['commit']):
        raise UpdateFailure('UPDATE_TARGET_INVALID')
    if request['repository'] != config['repository']:
        raise UpdateFailure('UPDATE_SOURCE_NOT_ALLOWED')


def dispatch(request, config):
    validate_request(request, config)
    with open(STATE_DIR / 'dispatch.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_json(STATUS_FILE)
        if state and state['status'] == 'running':
            # An interrupted systemd job must not leave the panel permanently "running".
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(state['startedAt'])).total_seconds()
            if age > 15:
                try:
                    active = run(['systemctl', 'show', '--property=ActiveState', '--value', 'incudal-update@' + state['id'] + '.service'])
                    if active not in ('active', 'activating', 'reloading', 'deactivating'):
                        raise UpdateFailure('UPDATE_INTERRUPTED')
                except UpdateFailure:
                    state = read_json(STATUS_FILE)
                    if state['status'] == 'running':
                        state.update(status='failed', phase='failed', error='UPDATE_INTERRUPTED', finishedAt=now(), exitCode=1)
                        write_json(STATUS_FILE, state)
        if request['action'] == 'apply':
            if state and state['id'] == request['id']:
                return {'protocol': 1, 'sourceRepository': config['repository'], 'installDirectory': config['directory'], 'execution': state}
            if state and state['status'] == 'running':
                raise UpdateFailure('UPDATE_IN_PROGRESS')
            state = {'id': request['id'], 'status': 'running', 'sourceRepository': config['repository'], 'mode': 'docker',
                     'targetCommit': request['commit'], 'previousCommit': None, 'phase': 'queued', 'startedAt': now(),
                     'finishedAt': None, 'exitCode': None, 'output': '', 'error': None}
            write_json(STATUS_FILE, state)
            try:
                run(['systemctl', 'start', '--no-block', 'incudal-update@' + state['id'] + '.service'])
            except UpdateFailure:
                state.update(status='failed', phase='failed', error='UPDATE_EXECUTOR_UNAVAILABLE', finishedAt=now(), exitCode=1)
                write_json(STATUS_FILE, state)
                raise
        return {'protocol': 1, 'sourceRepository': config['repository'], 'installDirectory': config['directory'], 'execution': state}


def serve():
    config = read_json(CONFIG_FILE)
    SOCKET_DIR.mkdir(mode=0o750, exist_ok=True)
    os.chown(SOCKET_DIR, 0, config['appGid'])
    # Both systemd and main() use umask 0077; restore group traversal explicitly.
    SOCKET_DIR.chmod(0o750)
    if SOCKET_FILE.exists():
        if not stat.S_ISSOCK(SOCKET_FILE.lstat().st_mode):
            raise UpdateFailure('UPDATE_EXECUTOR_INVALID')
        SOCKET_FILE.unlink()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(3)
            _pid, uid, _gid = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            try:
                if uid not in (0, config['appUid']):
                    raise UpdateFailure('UPDATE_SOURCE_NOT_ALLOWED')
                line = self.rfile.readline(8193)
                if len(line) > 8192 or not line.endswith(b'\n'):
                    raise UpdateFailure('UPDATE_REQUEST_INVALID')
                response = dispatch(json.loads(line), config)
            except UpdateFailure as error:
                response = {'code': str(error)}
            except Exception:
                response = {'code': 'UPDATE_REQUEST_INVALID'}
            self.wfile.write(json.dumps(response).encode() + b'\n')

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
    with Server(str(SOCKET_FILE), Handler) as server:
        os.chown(SOCKET_FILE, 0, config['appGid'])
        SOCKET_FILE.chmod(0o660)
        server.serve_forever()


def install(directory, repository, app_uid, app_gid):
    directory = Path(directory).resolve(strict=True)
    if not (directory / '.git').is_dir() or not (directory / '.env').is_file() or str(directory) == '/':
        raise UpdateFailure('UPDATE_SOURCE_INSTALL_REQUIRED')
    if not REPOSITORY.fullmatch(repository):
        raise UpdateFailure('UPDATE_SOURCE_NOT_ALLOWED')
    CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    existing = read_json(CONFIG_FILE)
    if existing and existing['directory'] != str(directory):
        raise UpdateFailure('UPDATE_EXECUTOR_ALREADY_CONFIGURED')
    if existing:
        config = {**existing, 'repository': repository, 'appUid': app_uid, 'appGid': app_gid}
    else:
        original = json.loads(run(['docker', 'compose', 'config', '--format', 'json'], cwd=str(directory)))
        if not original.get('services', {}).get('app', {}).get('build') or 'db' not in original['services']:
            raise UpdateFailure('UPDATE_SOURCE_INSTALL_REQUIRED')
        env_files = ''
        for line in (directory / '.env').read_text().splitlines():
            if line.startswith('COMPOSE_FILE='):
                env_files = line.split('=', 1)[1].strip().strip('"').strip("'")
        files = env_files.split(':') if env_files else ['docker-compose.yml'] + (['docker-compose.override.yml'] if (directory / 'docker-compose.override.yml').exists() else [])
        resolved = [str((directory / file).resolve(strict=True)) for file in files]
        if any(not Path(file).is_relative_to(directory) for file in resolved):
            raise UpdateFailure('UPDATE_SOURCE_INSTALL_REQUIRED')
        config = {'directory': str(directory), 'repository': repository, 'project': original['name'], 'files': resolved, 'appUid': app_uid, 'appGid': app_gid}
        write_json(OVERRIDE, {'services': {'app': {
            'image': original['services']['app'].get('image') or original['name'] + '-app',
            'environment': {'INCUDAL_UPDATE_SOCKET': str(SOCKET_FILE)},
            'volumes': [{'type': 'bind', 'source': str(SOCKET_DIR), 'target': str(SOCKET_DIR), 'read_only': True}]
        }}})
        env_path = directory / '.env'
        lines = [line for line in env_path.read_text().splitlines() if not line.startswith('COMPOSE_FILE=')]
        lines.append('COMPOSE_FILE=' + ':'.join(config['files'] + [str(OVERRIDE)]))
        env_path.write_text('\n'.join(lines) + '\n')
        env_path.chmod(0o600)
    write_json(CONFIG_FILE, config)
    EXECUTOR.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    shutil.copyfile(Path(__file__).resolve(), EXECUTOR)
    EXECUTOR.chmod(0o755)
    service_dir = Path('/etc/systemd/system')
    (service_dir / 'incudal-updater.service').write_text('[Unit]\nDescription=Incudal panel update RPC\nAfter=docker.service\n[Service]\nExecStart=/usr/bin/python3 ' + str(EXECUTOR) + ' serve\nRestart=on-failure\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n')
    (service_dir / 'incudal-update@.service').write_text('[Unit]\nDescription=Incudal panel update job %i\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + str(EXECUTOR) + ' run %i\nUMask=0077\nNoNewPrivileges=true\nTimeoutStartSec=5400\n')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'incudal-updater.service'])
    run(['systemctl', 'restart', 'incudal-updater.service'])
    print('Updater installed. Run docker compose up -d --no-build app to attach the update socket.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    setup = sub.add_parser('install')
    setup.add_argument('--project-dir', default=os.getcwd())
    setup.add_argument('--repository', default='mastalee928/incudal-oci')
    setup.add_argument('--app-uid', type=int, default=1001)
    setup.add_argument('--app-gid', type=int, default=1001)
    sub.add_parser('serve')
    job = sub.add_parser('run')
    job.add_argument('id')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise UpdateFailure('UPDATE_ROOT_REQUIRED')
    if args.command == 'install':
        install(args.project_dir, args.repository, args.app_uid, args.app_gid)
    elif args.command == 'serve':
        serve()
    else:
        execute(args.id)


if __name__ == '__main__':
    try:
        main()
    except UpdateFailure as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
