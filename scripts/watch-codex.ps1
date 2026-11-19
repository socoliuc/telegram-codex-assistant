param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskLocal = Join-Path $taskRoot '.local'
. (Join-Path $PSScriptRoot 'instance-status.ps1')
$taskHash = [System.Security.Cryptography.SHA256]::Create()
$taskHashText = [BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 20)
$taskHash.Dispose()
$taskMutex = New-Object Threading.Mutex($false, ('Local\CodexTelegramGuardian-' + $taskHashText))
$taskOwnsMutex = $false
try {
    try { $taskOwnsMutex = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskOwnsMutex = $true }
    if (-not $taskOwnsMutex -and -not $CheckOnly) { exit 0 }
    do {
        $taskDesktopRunning = $false
        $taskListenerRunning = $false
        $taskPaused = Test-Path -LiteralPath (Join-Path $taskLocal 'paused.json')
        $taskStatus = 'watching'
        try {
            $taskSession = (Get-Process -Id $PID).SessionId
            $taskDesktopRunning = @((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) | Where-Object {
                $_.SessionId -eq $taskSession -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$|\\OpenAI\\Codex\\ChatGPT\.exe$'
            }).Count -gt 0
            $taskLockPath = Join-Path $taskLocal 'instance.json'
            if (Test-Path -LiteralPath $taskLockPath) {
                $taskInstanceStatus = Get-TelegramInstanceStatus -Path $taskLockPath
                if ($taskInstanceStatus -eq 'unknown') { throw 'Instance owner could not be verified.' }
                $taskListenerRunning = $taskInstanceStatus -eq 'running'
            }
            if ($taskPaused) { $taskStatus = 'paused' }
            elseif ($taskDesktopRunning -and -not $taskListenerRunning -and -not $CheckOnly) {
                & (Join-Path $PSScriptRoot 'start.ps1') -Automatic | Out-Null
                $taskStatus = 'launch-requested'
            }
            elseif (-not $taskDesktopRunning) { $taskStatus = 'waiting-for-codex' }
        } catch { $taskStatus = 'needs-attention' }
        $taskHealth = @{ pid = $PID; at = [DateTime]::UtcNow.ToString('o'); status = $taskStatus;
            desktopRunning = $taskDesktopRunning; listenerRunning = $taskListenerRunning; paused = $taskPaused; intervalSeconds = 5 }
        if ($CheckOnly) { $taskHealth | ConvertTo-Json; break }
        $taskHealth | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLocal 'guardian.json')
        Start-Sleep -Seconds 5
    } while ($true)
} finally {
    if ($taskOwnsMutex) { $taskMutex.ReleaseMutex() }
    $taskMutex.Dispose()
}
