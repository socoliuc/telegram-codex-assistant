param([ValidateSet('Protect', 'Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
$taskInput = [Console]::In.ReadToEnd().Trim()
try {
    if ($Mode -eq 'Protect') {
        $taskSecure = ConvertTo-SecureString -String $taskInput -AsPlainText -Force
        [Console]::Out.Write((ConvertFrom-SecureString -SecureString $taskSecure))
    } else {
        $taskSecure = ConvertTo-SecureString -String $taskInput
        $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
        try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    }
} catch {
    [Console]::Error.Write('Credential protection failed.')
    exit 1
} finally { $taskInput = $null; $taskSecure = $null }
