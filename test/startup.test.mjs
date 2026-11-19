import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, basename } from 'node:path';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
function temporary() {
  // Windows runners can expose TEMP through an 8.3 alias. Match the path
  // PowerShell uses for PSScriptRoot when simulating an existing installation.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-startup-')));
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, '.local'));
  writeFileSync(join(dir, '.local', 'config.json'), '{}');
  return { dir, cleanup() {
    assert.ok(realpathSync.native(dir).startsWith(realpathSync.native(tmpdir()) + sep) && basename(dir).startsWith('tg-startup-'));
    rmSync(dir, { recursive: true, force: true });
  } };
}
function registration(root, foreign = false) {
  const script = `
$ErrorActionPreference = 'Stop'
# Load the module before stubbing its exported functions; lazy import would
# otherwise replace the stubs with real task registration functions.
Import-Module ScheduledTasks
$global:tgStartupTestRegistered = $null
$global:tgStartupTestStarts = 0
$global:tgStartupTestForeign = $${foreign}
$global:tgStartupTestRoot = ${quote(root)}
function Get-ScheduledTask {
  param($TaskName, $ErrorAction)
  if ($global:tgStartupTestRegistered) { return [pscustomobject]@{ TaskName=$TaskName; State='Ready'; Description=$global:tgStartupTestRegistered.Description } }
  return [pscustomobject]@{ Description=$(if ($global:tgStartupTestForeign) { 'Other installation' } else { 'Managed by Telegram Codex assistant: ' + $global:tgStartupTestRoot }) }
}
function Register-ScheduledTask {
  param($TaskName, $Description, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
  $global:tgStartupTestRegistered = @{ Description=$Description; Action=$Action; Triggers=@($Trigger); Principal=$Principal; Settings=$Settings }
}
function Start-ScheduledTask { param($TaskName) $global:tgStartupTestStarts++ }
try {
  & ${quote(join(root, 'scripts', 'install-startup.ps1'))} | Out-Null
  $r = $global:tgStartupTestRegistered
  [pscustomobject]@{ registered=$true; starts=$global:tgStartupTestStarts;
    logonTriggers=@($r.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count;
    repetitions=@($r.Triggers | Where-Object { $_.Repetition.Interval } | ForEach-Object { [pscustomobject]@{ interval=$_.Repetition.Interval; duration=$_.Repetition.Duration; stopAtEnd=$_.Repetition.StopAtDurationEnd } });
    guiHost=($r.Action.Execute -match '\\\\pythonw\\.exe$');
    launcherCorrect=($r.Action.Arguments.Contains((Join-Path $global:tgStartupTestRoot 'scripts\\launch-silent.pyw')) -and $r.Action.Arguments.EndsWith(' watcher'));
    ignoreNew=($r.Settings.MultipleInstances -eq 2); limited=($r.Principal.RunLevel -eq 0);
    interactive=($r.Principal.LogonType -eq 3); unlimited=($r.Settings.ExecutionTimeLimit -eq 'PT0S')
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [pscustomobject]@{ registered=($null -ne $global:tgStartupTestRegistered); starts=$global:tgStartupTestStarts; rejectedForeign=$_.Exception.Message.Contains('different task'); reason=$_.Exception.Message; at=$_.ScriptStackTrace } | ConvertTo-Json -Compress
}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
function taskHash() {
  const script = `$t=Get-ScheduledTask -TaskName 'Codex Telegram Assistant' -ErrorAction SilentlyContinue; if (-not $t) { 'absent' } else { $xml=Export-ScheduledTask -TaskName $t.TaskName; $sha=[Security.Cryptography.SHA256]::Create(); [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml))) }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}

test('startup uses a hidden GUI launcher plus an independent indefinite recovery trigger', { skip: process.platform !== 'win32' }, () => {
  const f = temporary(); try {
    copyFileSync(new URL('../scripts/install-startup.ps1', import.meta.url), join(f.dir, 'scripts', 'install-startup.ps1'));
    copyFileSync(new URL('../scripts/silent-launcher.ps1', import.meta.url), join(f.dir, 'scripts', 'silent-launcher.ps1'));
    const before = taskHash();
    const r = registration(f.dir);
    assert.equal(taskHash(), before, 'isolated registration must never change the installed task');
    assert.equal(r.registered, true, r.reason + '\n' + r.at); assert.equal(r.starts, 1); assert.equal(r.logonTriggers, 1);
    assert.deepEqual(r.repetitions.map(t => t.interval), ['PT1M']);
    assert.ok(!r.repetitions[0].duration); assert.equal(r.repetitions[0].stopAtEnd, false);
    assert.ok(r.guiHost && r.launcherCorrect && r.ignoreNew && r.limited && r.interactive && r.unlimited, JSON.stringify(r));
  } finally { f.cleanup(); }
});

test('startup never replaces another installation sharing the task name', { skip: process.platform !== 'win32' }, () => {
  const f = temporary(); try {
    copyFileSync(new URL('../scripts/install-startup.ps1', import.meta.url), join(f.dir, 'scripts', 'install-startup.ps1'));
    copyFileSync(new URL('../scripts/silent-launcher.ps1', import.meta.url), join(f.dir, 'scripts', 'silent-launcher.ps1'));
    const r = registration(f.dir, true);
    assert.equal(r.registered, false); assert.equal(r.starts, 0); assert.equal(r.rejectedForeign, true);
  } finally { f.cleanup(); }
});

test('hidden launcher waits for its watcher and preserves its exit status without opening a terminal', { skip: process.platform !== 'win32' }, () => {
  const f = temporary(); try {
    copyFileSync(new URL('../scripts/watch-codex-hidden.vbs', import.meta.url), join(f.dir, 'scripts', 'watch-codex-hidden.vbs'));
    const marker = join(f.dir, 'watcher-ran.txt');
    writeFileSync(join(f.dir, 'scripts', 'watch-codex.ps1'), `Set-Content -LiteralPath ${quote(marker)} -Value 'completed'\nexit 7\n`);
    const result = spawnSync(join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//Nologo', join(f.dir, 'scripts', 'watch-codex-hidden.vbs')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 7, result.stderr); assert.equal(readFileSync(marker, 'utf8').trim(), 'completed');
  } finally { f.cleanup(); }
});
