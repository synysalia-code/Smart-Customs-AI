$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { exit 0 }
$savedProcessId = [int](Get-Content -LiteralPath $pidFile)
$savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId"
$expectedApp = Join-Path $PSScriptRoot 'app.py'
if ($savedProcess -and $savedProcess.CommandLine -and $savedProcess.CommandLine.Contains($expectedApp)) {
    Stop-Process -Id $savedProcessId
    Remove-Item -LiteralPath $pidFile
}
