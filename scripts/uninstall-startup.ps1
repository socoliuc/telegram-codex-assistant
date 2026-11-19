$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'Codex Telegram Assistant'
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $taskExisting) { Write-Output 'Startup task is not installed.'; exit 0 }
if ($taskExisting.Description -ne ('Managed by Telegram Codex assistant: ' + $taskRoot)) { throw 'This task belongs to a different installation; it was preserved.' }
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output 'Automatic startup removed. The listener and any active work were left running.'
