"""GUI-hosted guardian/listener launcher; never allocate a console."""
import json
import os
from pathlib import Path
import subprocess
import sys

# Keep the caller's junction spelling: watch-codex.ps1 derives its singleton
# mutex from that spelling. Resolving a junction alias could duplicate a watcher.
ROOT = Path(__file__).absolute().parent.parent


def launch(mode):
    options = dict(cwd=str(ROOT), stdin=subprocess.DEVNULL,
                   creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    if mode == 'watcher':
        powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        command = [str(powershell), '-NoProfile', '-NonInteractive',
                   '-ExecutionPolicy', 'Bypass', '-File',
                   str(ROOT / 'scripts' / 'watch-codex.ps1')]
        return subprocess.run(command, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, **options).returncode
    if mode == 'listener':
        local = ROOT / '.local'
        config = json.loads((local / 'config.json').read_text(encoding='utf-8-sig'))
        with (local / 'stdout.log').open('w', encoding='utf-8') as output, \
                (local / 'stderr.log').open('w', encoding='utf-8') as error:
            return subprocess.run([config['nodeBin'], str(ROOT / 'src' / 'main.mjs')],
                                  stdout=output, stderr=error, **options).returncode
    raise ValueError('Unsupported launcher mode')


if __name__ == '__main__':
    try:
        sys.exit(launch(sys.argv[1]))
    except (OSError, ValueError, KeyError, IndexError):
        # Task Scheduler receives failure; never print config/token/error text.
        sys.exit(1)
