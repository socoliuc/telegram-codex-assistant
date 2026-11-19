import ctypes
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).absolute().parent.parent / 'scripts' / 'launch-silent.pyw'


class SilentLauncherTests(unittest.TestCase):
    def load(self):
        self.assertTrue(SOURCE.is_file(), 'Console-free launcher must exist')
        loader = importlib.machinery.SourceFileLoader('telegram_silent_fixture', str(SOURCE))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def test_process_flags_and_exit_status(self):
        module = self.load()
        with patch.object(module.subprocess, 'run') as run:
            run.return_value.returncode = 7
            self.assertEqual(module.launch('watcher'), 7)
            args, options = run.call_args
            self.assertIn('watch-codex.ps1', args[0][-1])
            self.assertEqual(options['creationflags'], subprocess.CREATE_NO_WINDOW)
            self.assertFalse(options.get('shell', False))
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            self.assertEqual(options['stdout'], subprocess.DEVNULL)

    def test_real_gui_parent_and_console_child_have_no_console(self):
        self.load()
        pythonw = Path(sys.executable).with_name('pythonw.exe')
        self.assertTrue(pythonw.is_file())
        with tempfile.TemporaryDirectory(prefix='tg-silent-') as temp:
            root = Path(temp)
            (root / 'scripts').mkdir()
            (root / '.local').mkdir()
            (root / 'src').mkdir()
            (root / 'scripts' / 'launch-silent.pyw').write_bytes(SOURCE.read_bytes())
            marker = root / 'watcher-proof.json'
            probe = "$s='using System;using System.Runtime.InteropServices;public class NoConsoleProbe{[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();}';Add-Type $s;[pscustomobject]@{console=[NoConsoleProbe]::GetConsoleWindow().ToInt64();pid=$PID}|ConvertTo-Json|Set-Content -LiteralPath '" + str(marker).replace("'", "''") + "';exit 7"
            (root / 'scripts' / 'watch-codex.ps1').write_text(probe, encoding='utf-8')
            result = subprocess.run([str(pythonw), str(root / 'scripts' / 'launch-silent.pyw'), 'watcher'], creationflags=subprocess.CREATE_NO_WINDOW, timeout=20)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(json.loads(marker.read_text(encoding='utf-8-sig'))['console'], 0)
            listener = root / 'listener-proof.json'
            (root / '.local' / 'config.json').write_text(json.dumps({'nodeBin': sys.executable}), encoding='utf-8')
            (root / 'src' / 'main.mjs').write_text('import ctypes,json,pathlib\npathlib.Path(' + repr(str(listener)) + ').write_text(json.dumps({"console":ctypes.windll.kernel32.GetConsoleWindow()}))\nprint("synthetic output")\nraise SystemExit(9)\n', encoding='utf-8')
            result = subprocess.run([str(pythonw), str(root / 'scripts' / 'launch-silent.pyw'), 'listener'], creationflags=subprocess.CREATE_NO_WINDOW, timeout=20)
            self.assertEqual(result.returncode, 9)
            self.assertEqual(json.loads(listener.read_text())['console'], 0)
            self.assertEqual((root / '.local' / 'stdout.log').read_text().strip(), 'synthetic output')


if __name__ == '__main__':
    unittest.main()
