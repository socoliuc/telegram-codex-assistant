$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.local\config.json'))) { throw 'Run Setup.cmd first.' }
$taskName = 'Codex Telegram Assistant'
$taskDescription = 'Managed by Telegram Codex assistant: ' + $taskRoot
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting -and $taskExisting.Description -ne $taskDescription) { throw 'A different task already uses this name; it was preserved.' }
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
. (Join-Path $PSScriptRoot 'silent-launcher.ps1')
$taskGuiHost = Get-TelegramPythonw
$taskAction = New-ScheduledTaskAction -Execute $taskGuiHost -Argument ('"' + (Join-Path $PSScriptRoot 'launch-silent.pyw') + '" watcher') -WorkingDirectory $taskRoot
$taskLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
# A cancelled guardian may not qualify for RestartOnFailure. This independent
# trigger recovers it without another logon; IgnoreNew preserves a live instance.
$taskRecoveryTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskRecoveryTrigger.Repetition.StopAtDurationEnd = $false
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $taskAction -Trigger @($taskLogonTrigger, $taskRecoveryTrigger) -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State, Description
