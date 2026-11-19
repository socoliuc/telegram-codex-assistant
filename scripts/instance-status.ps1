param([string]$LockPath)

function Get-TelegramInstanceStatus {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 'stale' }
    try {
        $recordFile = Get-Item -LiteralPath $Path -ErrorAction Stop
        $record = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $record.pid -or $record.pid -le 0 -or $record.pid -gt [int]::MaxValue -or [long]$record.pid -ne $record.pid) { return 'unknown' }
        $ownerProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if ($null -eq $ownerProcess) { return 'stale' }
        $started = $ownerProcess.StartTime
        if ($null -eq $started) {
            # Protected system processes may hide StartTime. CIM still exposes
            # their creation date, allowing recovery after a PID is reused.
            $started = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$record.pid) -ErrorAction Stop).CreationDate
        }
        if ($null -eq $started) { return 'unknown' }
        # The lock is written after its owner starts. A newer process cannot
        # own this lock, even if Windows has assigned it the same numeric PID.
        if ($started.ToUniversalTime() -gt $recordFile.LastWriteTimeUtc) { return 'stale' }
        return 'running'
    } catch { return 'unknown' }
}

if ($LockPath) { Get-TelegramInstanceStatus -Path $LockPath }
