Option Explicit
Dim shell, files, scripts, powershell, watcher, quote, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scripts = files.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
watcher = files.BuildPath(scripts, "watch-codex.ps1")
quote = Chr(34)
command = quote & powershell & quote & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & quote & watcher & quote
' Hide the console at creation, before PowerShell parses WindowStyle. Wait so
' Task Scheduler owns the watcher lifetime and receives its real exit status.
result = shell.Run(command, 0, True)
WScript.Quit result
