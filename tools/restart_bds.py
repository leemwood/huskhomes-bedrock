"""Announce, count down, gracefully stop, optionally update a pack, then reopen the same visible terminal."""
from pathlib import Path
import argparse
import ctypes as c
import ctypes.wintypes as w
import datetime
import hashlib
import json
import subprocess
import time
import zipfile

from bds_console import send_commands


def process_exists(pid):
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        if c.get_last_error() in (87, 1168):
            return False
        raise c.WinError(c.get_last_error())
    try:
        status = w.DWORD()
        if not kernel.GetExitCodeProcess(handle, c.byref(status)):
            raise c.WinError(c.get_last_error())
        return status.value == 259
    finally:
        kernel.CloseHandle(handle)


def announce(server, pid, message):
    logfile = server / 'server-console.log'
    offset = logfile.stat().st_size
    # ASCII JSON escapes survive the BDS console input encoding; successful tellraw has no output.
    command = 'tellraw @a ' + json.dumps({'rawtext': [{'text': '\u00a7e' + message}]}, ensure_ascii=True)
    # A read-only command is a barrier proving that the preceding broadcast has been processed.
    send_commands(pid, [command, 'list'])
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with logfile.open('rb') as file:
            file.seek(offset)
            output = file.read().decode('utf-8', errors='replace')
            if 'players online:' in output:
                if 'Syntax error' in output or 'Unknown command' in output or 'Cheats are not enabled' in output:
                    raise RuntimeError('Server rejected the restart announcement: ' + output)
                return
        time.sleep(0.1)
    raise RuntimeError('No server response after restart announcement')


def update_pack(server, source, view_distance=None):
    with zipfile.ZipFile(source) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('manifest.json'))
        uuid = manifest['header']['uuid']
        packdir = (server / 'behavior_packs' / 'HuskHomes_BP').resolve()
        assert uuid == '7e7bb539-c59d-4c64-a07f-4f5cb6fad61c'
        assert packdir.is_relative_to(server / 'behavior_packs')
        previous = json.loads((packdir / 'manifest.json').read_text(encoding='utf-8'))
        assert previous['header']['uuid'] == uuid
        world_name = next(line.split('=', 1)[1].strip() for line in
                          (server / 'server.properties').read_text(encoding='utf-8-sig').splitlines()
                          if line.startswith('level-name='))
        world = (server / 'worlds' / world_name).resolve()
        assert world.is_relative_to(server / 'worlds') and (world / 'level.dat').is_file()
        stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
        backup = server / 'backups' / f'before-huskhomes-update-{stamp}.zip'
        backup.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(backup, 'x', compression=zipfile.ZIP_DEFLATED) as saved:
            for directory in [world, server / 'behavior_packs']:
                for path in directory.rglob('*'):
                    if path.is_file():
                        saved.write(path, path.relative_to(server).as_posix())
            for name in ['server.properties', 'permissions.json', 'allowlist.json', 'huskhomes-installation.json']:
                path = server / name
                if path.is_file():
                    saved.write(path, name)
        with zipfile.ZipFile(backup) as saved:
            assert saved.testzip() is None
        print('Backup:', backup, flush=True)
        if view_distance is not None:
            properties_path = server / 'server.properties'
            properties = properties_path.read_text(encoding='utf-8-sig').splitlines()
            properties = [f'view-distance={view_distance}' if line.startswith('view-distance=') else line for line in properties]
            properties_path.write_text('\n'.join(properties) + '\n', encoding='utf-8')
        # All paths are validated before any replacement. Keep the UUID to preserve world properties.
        for entry in archive.infolist():
            assert (packdir / entry.filename).resolve().is_relative_to(packdir)
        archive.extractall(packdir)
        stackpath = world / 'world_behavior_packs.json'
        stack = json.loads(stackpath.read_text(encoding='utf-8-sig'))
        assert any(item['pack_id'] == uuid for item in stack)
        for item in stack:
            if item['pack_id'] == uuid:
                item['version'] = manifest['header']['version']
        temporary = stackpath.with_suffix('.json.hh.tmp')
        temporary.write_text(json.dumps(stack, indent=2) + '\n', encoding='utf-8'); temporary.replace(stackpath)
        report_path = server / 'huskhomes-installation.json'
        report = json.loads(report_path.read_text(encoding='utf-8-sig'))
        report.update({'backup': str(backup), 'version': manifest['header']['version'],
                       'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                       'restart_notice_seconds': 60, 'verification': 'Pending startup verification'})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('Updated pack:', manifest['header']['version'], flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', type=Path, required=True)
    parser.add_argument('--update-pack', type=Path)
    parser.add_argument('--view-distance', type=int, choices=range(5, 33), metavar='5..32')
    args = parser.parse_args(); server = args.server.resolve()
    if args.view_distance and not args.update_pack:
        parser.error('--view-distance requires --update-pack so a backup is made before changing settings')
    expected_version = '.'.join(map(str, json.loads((server / 'behavior_packs' / 'HuskHomes_BP' / 'manifest.json')
                                .read_text(encoding='utf-8'))['header']['version']))
    state = server / 'server-console-process.json'
    pid = json.loads(state.read_text(encoding='utf-8-sig'))['server_pid']
    if not process_exists(pid):
        raise RuntimeError('BDS is not running; use start-server.cmd')
    # Determine the cmd ancestor before stopping the server/wrapper processes.
    query = f"$b = Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $b.ParentProcessId); Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.ParentProcessId) | Select-Object ProcessId,Name | ConvertTo-Json -Compress"
    terminal = json.loads(subprocess.check_output(['powershell.exe', '-NoProfile', '-Command', query], text=True))
    if terminal['Name'].lower() != 'cmd.exe':
        raise RuntimeError('Could not identify the existing visible cmd terminal')
    if args.update_pack:
        with zipfile.ZipFile(args.update_pack) as archive:
            assert archive.testzip() is None
            header = json.loads(archive.read('manifest.json'))['header']
            assert header['uuid'] == '7e7bb539-c59d-4c64-a07f-4f5cb6fad61c'
            expected_version = '.'.join(map(str, header['version']))
    notice = '[服务器通知] 准备重启：60 秒后保存世界并安装家与传送修复，预计停服约 15 秒，请暂勿进行危险操作。'
    announce(server, pid, notice)
    print('Restart notice delivered; 60-second countdown started.', flush=True)
    started = time.monotonic()
    for remaining in [30, 10, 5, 4, 3, 2, 1]:
        delay = started + 60 - remaining - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        announce(server, pid, f'[服务器通知] {remaining} 秒后重启，世界将自动保存。')
        print('Countdown:', remaining, flush=True)
    time.sleep(max(0, started + 60 - time.monotonic()))
    send_commands(pid, ['stop'])
    deadline = time.monotonic() + 40
    while process_exists(pid):
        if time.monotonic() > deadline:
            raise RuntimeError('Graceful stop timed out; server was not force-killed')
        time.sleep(0.2)
    if args.update_pack:
        update_pack(server, args.update_pack.resolve(), args.view_distance)
    time.sleep(1)
    old_stamp = state.stat().st_mtime_ns
    send_commands(terminal['ProcessId'], ['"' + str(server / 'start-server.cmd') + '"'])
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if state.stat().st_mtime_ns != old_stamp:
            new_pid = json.loads(state.read_text(encoding='utf-8-sig'))['server_pid']
            log = (server / 'server-console.log').read_text(encoding='utf-8')
            latest = log[log.rfind('--- SERVER START'):]
            if process_exists(new_pid) and f'[HuskHomes] {expected_version} 已加载' in latest:
                if ' ERROR]' in latest or '初始化失败' in latest:
                    raise RuntimeError('Server startup contains errors; inspect console log')
                print('Restart complete; visible console retained. PID:', new_pid, flush=True)
                return
        time.sleep(0.2)
    raise RuntimeError('Server startup did not finish; inspect the visible terminal')


if __name__ == '__main__':
    main()
