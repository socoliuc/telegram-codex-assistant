$ErrorActionPreference = 'Stop'
$taskLocal = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
if (-not (Test-Path -LiteralPath $taskLocal)) { New-Item -ItemType Directory -Path $taskLocal | Out-Null }
@{ pausedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLocal 'paused.json')
$taskLockPath = Join-Path $taskLocal 'instance.json'
if (-not (Test-Path -LiteralPath $taskLockPath)) { Write-Output 'Assistant is not running.'; exit 0 }
$taskLock = Get-Content -LiteralPath $taskLockPath -Raw | ConvertFrom-Json
@{ nonce = $taskLock.nonce } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLocal 'stop.json')
Write-Output 'Graceful stop requested. Automatic startup is paused until you run Start.cmd.'
