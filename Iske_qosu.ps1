$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $bundledPython) {
    $appPython = $bundledPython
} elseif ($pythonCommand) {
    $appPython = $pythonCommand.Source
} else {
    Write-Host 'Python 3.10+ qajet. Python ornatylyp, qayta iske qosynyz.'
    Read-Host 'Enter'
    exit 1
}
$appUrl = 'http://127.0.0.1:8765'
try {
    $existing = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 2
    if ($null -ne $existing.config -and $null -ne $existing.policy) {
        Start-Process $appUrl
        exit 0
    }
} catch { }
$scriptPath = Join-Path $appRoot 'app.py'
$appProcess = Start-Process -FilePath $appPython -ArgumentList @("`"$scriptPath`"", '--port', '8765') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $appRoot 'server.log') -RedirectStandardError (Join-Path $appRoot 'server-error.log')
Set-Content -LiteralPath (Join-Path $appRoot 'server.pid') -Value $appProcess.Id
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $ready = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 1
        if ($null -ne $ready.config) { Start-Process $appUrl; exit 0 }
    } catch { Start-Sleep -Milliseconds 300 }
}
Write-Host 'Server iske qosylmady. server-error.log failyn qaranyz.'
Read-Host 'Enter'
