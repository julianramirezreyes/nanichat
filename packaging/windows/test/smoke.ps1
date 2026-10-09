<#
.SYNOPSIS
  End-to-end smoke test of the Social Desk Windows installer (run by CI after compiling it; also usable by hand).

.DESCRIPTION
  Windows PowerShell 5.1 compatible (CI runs it with `shell: powershell`, the same engine the shortcuts use).
  Silent install -> launch.ps1 -> /api/health, /, /api/settings/features -> second launch is idempotent -> data files ->
  stop.ps1 (port closed, lock released) -> clean restart -> abrupt kill + restart (stale lock reclaimed by the app) ->
  lock whose PID was reused by another program (removed by the launcher) -> silent uninstall keeps the data.
  Prints PASS/FAIL lines, dumps log tails on failure and exits non-zero when anything failed.

  It uses the real per-user folders (%LOCALAPPDATA%\SocialDesk). To protect a real installation it refuses to run
  when %LOCALAPPDATA%\SocialDesk\data already exists, unless -SocialDeskHome points to a throwaway folder.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\test\smoke.ps1 -Installer dist\installer\SocialDesk-Setup-0.1.0.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$InstallDir = (Join-Path $env:TEMP 'SocialDeskSmoke\app'),
  [string]$ArtifactsDir = (Join-Path $env:TEMP 'SocialDeskSmoke\artifacts'),
  [string]$SocialDeskHome = '',
  [int]$TimeoutSeconds = 180
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$env:SOCIAL_DESK_NONINTERACTIVE = '1'
if ($SocialDeskHome) {
  $env:SOCIAL_DESK_HOME = $SocialDeskHome
  $HomeDir = $SocialDeskHome
} else {
  Remove-Item Env:SOCIAL_DESK_HOME -ErrorAction SilentlyContinue
  $HomeDir = Join-Path $env:LOCALAPPDATA 'SocialDesk'
}
$DataDir = Join-Path $HomeDir 'data'
$LogDir = Join-Path $HomeDir 'logs'
$RunDir = Join-Path $HomeDir 'run'
$LockFile = Join-Path $DataDir '.application-owner.json'
$NodeExe = Join-Path $InstallDir 'node\node.exe'
$Launch = Join-Path $InstallDir 'launcher\launch.ps1'
$Stop = Join-Path $InstallDir 'launcher\stop.ps1'
$StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Social Desk'

$script:Failures = 0
$script:Passes = 0
$script:Invocation = 0

function Write-Pass([string]$Name) { $script:Passes++; Write-Host "PASS: $Name" }
function Write-Fail([string]$Name, [string]$Detail = '') {
  $script:Failures++
  Write-Host "FAIL: $Name $Detail"
  if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::error title=Windows smoke test::$Name $Detail" }
}
function Assert-That([bool]$Condition, [string]$Name, [string]$Detail = '') {
  if ($Condition) { Write-Pass $Name } else { Write-Fail $Name $Detail }
  return $Condition
}
function Assert-Fatal([bool]$Condition, [string]$Name, [string]$Detail = '') {
  if (-not (Assert-That $Condition $Name $Detail)) { throw "fatal: $Name" }
}

function Invoke-Script([string]$Path, [string[]]$Arguments) {
  # Same engine and flags as the shortcuts. The child's output goes to files, never to a pipe: the server started by
  # launch.ps1 inherits handles, and a pipe it holds open would block this script (and the CI step) forever.
  $script:Invocation++
  $name = '{0:D2}-{1}' -f $script:Invocation, [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $out = Join-Path $ArtifactsDir "$name.out.log"
  $err = Join-Path $ArtifactsDir "$name.err.log"
  $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" {1}' -f $Path, ($Arguments -join ' ')
  $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList $argumentLine -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $process.Handle
  if (-not $process.WaitForExit(($TimeoutSeconds + 60) * 1000)) {
    & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null
    Write-Host "$name did not finish in time"
    return 124
  }
  foreach ($file in @($out, $err)) {
    $text = Read-Shared $file
    if ($text) { Write-Host "----- $name output ($([System.IO.Path]::GetFileName($file))) -----"; Write-Host $text }
  }
  return [int]$process.ExitCode
}

function Read-Shared([string]$Path) {
  # The server may still hold these files open: read with full sharing.
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { return (New-Object System.IO.StreamReader($stream)).ReadToEnd().Trim() } finally { $stream.Dispose() }
  } catch {
    return "(could not read $Path`: $($_.Exception.Message))"
  }
}

function Get-Http([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 15
    return @{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
  } catch {
    $status = 0
    $responseProperty = $_.Exception.PSObject.Properties['Response']
    if ($responseProperty -and $responseProperty.Value) { $status = [int]$responseProperty.Value.StatusCode }
    return @{ Status = $status; Body = $_.Exception.Message }
  }
}

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Read-Text([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return ([System.IO.File]::ReadAllText($Path)).Trim() }
  return ''
}

function Get-OurNodeIds {
  return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $NodeExe, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { [int]$_.ProcessId })
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return [bool](& $Condition)
}

function Show-LogTails {
  Write-Host '----- log tails -----'
  $files = @()
  if (Test-Path -LiteralPath $LogDir) { $files += @(Get-ChildItem -LiteralPath $LogDir -File | Sort-Object LastWriteTime) }
  if (Test-Path -LiteralPath $ArtifactsDir) { $files += @(Get-ChildItem -LiteralPath $ArtifactsDir -Filter '*.log' -File) }
  foreach ($file in $files) {
    Write-Host "===== $($file.FullName) (last 40 lines) ====="
    Get-Content -LiteralPath $file.FullName -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }
}

function Test-Running([string]$Label) {
  $port = 0
  $portText = Read-Text (Join-Path $RunDir 'port.txt')
  Assert-Fatal ([int]::TryParse($portText, [ref]$port)) "${Label}: run\port.txt has a port" "(found '$portText')"
  $health = Get-Http "http://127.0.0.1:$port/api/health"
  $ok = $false
  try { $json = $health.Body | ConvertFrom-Json; $ok = ($json.status -eq 'ok' -and $json.ready -eq $true) } catch { }
  Assert-Fatal ($health.Status -eq 200 -and $ok) "${Label}: /api/health is {status:ok, ready:true}" "(HTTP $($health.Status): $($health.Body))"
  return $port
}

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
Write-Host "Installer:   $Installer"
Write-Host "Install dir: $InstallDir"
Write-Host "Home:        $HomeDir"
Write-Host "PowerShell:  $($PSVersionTable.PSVersion)"

if (-not $SocialDeskHome -and (Test-Path -LiteralPath $DataDir)) {
  Write-Host "Refusing to run: $DataDir already exists (a real installation?). Use -SocialDeskHome <empty folder>."
  exit 2
}

try {
  # 1. Silent install.
  $installLog = Join-Path $ArtifactsDir 'install.log'
  $setup = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/DIR=`"$InstallDir`"", '/TASKS=""', "/LOG=`"$installLog`"")
  Assert-Fatal ($setup.ExitCode -eq 0) 'silent install exits with code 0' "(exit code $($setup.ExitCode))"
  foreach ($relative in @('node\node.exe', 'app\scripts\start.mjs', 'app\server.ts', 'app\.next\BUILD_ID', 'app\node_modules\tsx\package.json',
      'launcher\launch.ps1', 'launcher\stop.ps1', 'launcher\social-desk.ico', 'docs\Manual-Social-Desk.pdf', 'VERSION.txt', 'unins000.exe')) {
    Assert-That (Test-Path -LiteralPath (Join-Path $InstallDir $relative)) "installed: $relative" | Out-Null
  }
  foreach ($shortcut in @('Social Desk.lnk', 'Detener Social Desk.lnk', 'Manual de usuario.lnk')) {
    Assert-That (Test-Path -LiteralPath (Join-Path $StartMenuDir $shortcut)) "Start menu shortcut: $shortcut" | Out-Null
  }
  Assert-That (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'app\node_modules\typescript'))) 'no dev dependencies installed' | Out-Null
  $nodeVersion = (& $NodeExe -v)
  Assert-That ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v\d+\.\d+\.\d+$') "bundled node.exe runs ($nodeVersion)" | Out-Null
  Write-Host (Get-Content -LiteralPath (Join-Path $InstallDir 'VERSION.txt') -Raw)

  # 2. First launch.
  $code = Invoke-Script $Launch @('-NoBrowser', '-Quiet', '-TimeoutSeconds', "$TimeoutSeconds")
  Assert-Fatal ($code -eq 0) 'launch.ps1 starts the app' "(exit code $code)"
  $port = Test-Running 'first launch'
  $pid1 = Read-Text (Join-Path $RunDir 'pid.txt')
  $root = Get-Http "http://localhost:$port/"
  Assert-That ($root.Status -eq 200) 'GET / returns 200' "(HTTP $($root.Status))" | Out-Null
  $features = Get-Http "http://localhost:$port/api/settings/features"
  Assert-That ($features.Status -eq 200 -and $features.Body -match '"envImport"\s*:\s*false') 'GET /api/settings/features works' "(HTTP $($features.Status): $($features.Body))" | Out-Null
  $foreign = Get-Http "http://127.0.0.1:$port/api/health"
  Assert-That ($foreign.Status -eq 200) 'health answers on 127.0.0.1 as well' | Out-Null

  # 3. Second launch is idempotent.
  $code = Invoke-Script $Launch @('-NoBrowser', '-Quiet', '-TimeoutSeconds', "$TimeoutSeconds")
  Assert-That ($code -eq 0) 'second launch exits with code 0' "(exit code $code)" | Out-Null
  Assert-That ((Read-Text (Join-Path $RunDir 'port.txt')) -eq "$port") 'second launch keeps the same port' | Out-Null
  Assert-That ((Read-Text (Join-Path $RunDir 'pid.txt')) -eq $pid1) 'second launch keeps the same process' | Out-Null
  $nodes = @(Get-OurNodeIds)
  Assert-That ($nodes.Count -eq 1) 'exactly one Social Desk node process' "(found $($nodes.Count): $($nodes -join ', '))" | Out-Null

  # 4. Data lives in the per-user folder.
  foreach ($file in @('social-automation.sqlite', 'vault.key', '.application-owner.json')) {
    Assert-That (Test-Path -LiteralPath (Join-Path $DataDir $file)) "data file exists: $file" | Out-Null
  }
  Assert-That (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'app\data'))) 'no data folder inside the program folder' | Out-Null

  # 5. Stop.
  $code = Invoke-Script $Stop @('-Quiet')
  Assert-That ($code -eq 0) 'stop.ps1 exits with code 0' "(exit code $code)" | Out-Null
  Assert-That (Wait-Until { -not (Test-PortOpen $port) } 15) "port $port is closed after stop" | Out-Null
  Assert-That (-not (Test-Path -LiteralPath $LockFile)) 'instance lock released after stop' | Out-Null
  Assert-That (-not (Test-Path -LiteralPath (Join-Path $RunDir 'pid.txt'))) 'run\pid.txt removed after stop' | Out-Null
  Assert-That (@(Get-OurNodeIds).Count -eq 0) 'no Social Desk node process after stop' | Out-Null

  # 6. Clean restart, then an abrupt kill (like closing from Task Manager) and a restart over the stale lock.
  $code = Invoke-Script $Launch @('-NoBrowser', '-Quiet', '-TimeoutSeconds', "$TimeoutSeconds")
  Assert-Fatal ($code -eq 0) 'clean restart after stop' "(exit code $code)"
  $port = Test-Running 'clean restart'
  $killed = [int](Read-Text (Join-Path $RunDir 'pid.txt'))
  & taskkill.exe /PID $killed /T /F | Out-Null
  Assert-That (Wait-Until { -not (Get-Process -Id $killed -ErrorAction SilentlyContinue) } 15) 'abrupt kill stops the server' | Out-Null
  Assert-That (Test-Path -LiteralPath $LockFile) 'abrupt kill leaves the instance lock behind' | Out-Null
  $code = Invoke-Script $Launch @('-NoBrowser', '-Quiet', '-TimeoutSeconds', "$TimeoutSeconds")
  Assert-Fatal ($code -eq 0) 'restart after an abrupt kill reclaims the stale lock' "(exit code $code)"
  $port = Test-Running 'restart after abrupt kill'
  $code = Invoke-Script $Stop @('-Quiet')
  Assert-That ($code -eq 0) 'stop after the stale-lock restart' | Out-Null

  # 7. Stale lock whose PID now belongs to another program (this PowerShell process): the launcher removes it.
  $fakeLock = '{"pid":' + $PID + ',"processStart":null,"nonce":"smoke-test"}'
  [System.IO.File]::WriteAllText($LockFile, $fakeLock, (New-Object System.Text.UTF8Encoding($false)))
  $code = Invoke-Script $Launch @('-NoBrowser', '-Quiet', '-TimeoutSeconds', "$TimeoutSeconds")
  Assert-Fatal ($code -eq 0) 'launch removes a lock whose PID was reused by another program' "(exit code $code)"
  $port = Test-Running 'restart over a reused-PID lock'
  $code = Invoke-Script $Stop @('-Quiet')
  Assert-That ($code -eq 0) 'final stop' | Out-Null
  Assert-That (Wait-Until { -not (Test-PortOpen $port) } 15) 'port closed after the final stop' | Out-Null

  # 8. Silent uninstall keeps the data.
  $uninstaller = Join-Path $InstallDir 'unins000.exe'
  $uninstallLog = Join-Path $ArtifactsDir 'uninstall.log'
  $uninstall = Start-Process -FilePath $uninstaller -Wait -PassThru -ArgumentList @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$uninstallLog`"")
  Assert-That ($uninstall.ExitCode -eq 0) 'silent uninstall exits with code 0' "(exit code $($uninstall.ExitCode))" | Out-Null
  # The uninstaller re-launches a copy of itself from %TEMP%: wait for the program folder to disappear.
  Assert-That (Wait-Until { -not (Test-Path -LiteralPath (Join-Path $InstallDir 'unins000.exe')) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'app')) } 120) 'program folder removed by uninstall' | Out-Null
  Assert-That (-not (Test-Path -LiteralPath $InstallDir)) 'install directory itself removed' | Out-Null
  Assert-That (-not (Test-Path -LiteralPath $StartMenuDir)) 'Start menu folder removed' | Out-Null
  foreach ($file in @('social-automation.sqlite', 'vault.key')) {
    Assert-That (Test-Path -LiteralPath (Join-Path $DataDir $file)) "data kept after uninstall: $file" | Out-Null
  }
} catch {
  Write-Fail 'smoke test aborted' $_.Exception.Message
} finally {
  # Never leave a server running (it would also keep the CI step open).
  foreach ($id in @(Get-OurNodeIds)) { & taskkill.exe /PID $id /T /F 2>&1 | Out-Null }
  if (Test-Path -LiteralPath $LogDir) { Copy-Item -Path (Join-Path $LogDir '*') -Destination $ArtifactsDir -Force -ErrorAction SilentlyContinue }
  if ($script:Failures -gt 0) { Show-LogTails }
}

Write-Host ''
Write-Host "Smoke test: $($script:Passes) passed, $($script:Failures) failed"
if ($script:Failures -gt 0) { exit 1 }
exit 0
