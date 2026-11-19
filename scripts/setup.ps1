param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = $null
$taskConfigPath = Join-Path $taskRoot '.local\config.json'
if (Test-Path -LiteralPath $taskConfigPath) {
    $taskConfigured = (Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json).nodeBin
    if ($taskConfigured -and (Test-Path -LiteralPath $taskConfigured)) { $taskNode = $taskConfigured }
}
if (-not $taskNode) {
    $taskCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($taskCommand) { $taskNode = $taskCommand.Source }
}
if (-not $taskNode) {
    $taskBundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $taskBundled) { $taskNode = $taskBundled }
}
if (-not $taskNode) { throw 'Node 24+ was not found in PATH or the bundled Codex runtime.' }
$taskVersion = & $taskNode --version
if ($LASTEXITCODE -ne 0 -or [int]($taskVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node 24 or newer is required.' }
if ($CheckOnly) { Write-Output ('Node ready: ' + $taskVersion); exit 0 }
& $taskNode (Join-Path $taskRoot 'src\setup.mjs')
exit $LASTEXITCODE
