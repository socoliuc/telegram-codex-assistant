function Get-TelegramPythonw {
    $pythonw = Get-Command pythonw.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pythonw -and $pythonw.Source -notlike '*\Microsoft\WindowsApps\*') { return $pythonw.Source }
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    throw 'Install Python 3 for Windows and add its installation folder (containing pythonw.exe) to PATH.'
}
