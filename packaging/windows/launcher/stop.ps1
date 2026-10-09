<#
.SYNOPSIS
  Stops Social Desk: the process tree recorded in run\pid.txt, plus any leftover node.exe of this installation.

.DESCRIPTION
  Windows PowerShell 5.1 compatible. Windows has no SIGINT/SIGTERM for a hidden console process, so the server is
  terminated with taskkill /T /F. The database is SQLite in WAL mode and survives an abrupt stop; a send that was in
  flight at that moment stays UNKNOWN_OUTCOME (never retried automatically), exactly like a power cut.
  Only processes whose executable is this installation's node\node.exe are stopped (a reused PID is never killed).
  After a confirmed stop, the instance lock data\.application-owner.json is removed when it names a stopped PID.

.PARAMETER Quiet
  No dialog box (uninstaller, upgrades, CI). Also enabled by SOCIAL_DESK_NONINTERACTIVE=1.
#>
[CmdletBinding()]
param(
  [switch]$Quiet
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallDir = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $InstallDir 'node\node.exe'
$HomeDir = if ($env:SOCIAL_DESK_HOME) { $env:SOCIAL_DESK_HOME } else { Join-Path $env:LOCALAPPDATA 'SocialDesk' }
$DataDir = Join-Path $HomeDir 'data'
$LogDir = Join-Path $HomeDir 'logs'
$RunDir = Join-Path $HomeDir 'run'
$PidFile = Join-Path $RunDir 'pid.txt'
$PortFile = Join-Path $RunDir 'port.txt'
$LockFile = Join-Path $DataDir '.application-owner.json'
$LauncherLog = Join-Path $LogDir 'launcher.log'
$Interactive = -not ($Quiet -or $env:SOCIAL_DESK_NONINTERACTIVE -eq '1')

function Write-LauncherLog([string]$Message) {
  $line = '{0} [stop] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if (Test-Path -LiteralPath $LogDir) {
    try { Add-Content -LiteralPath $LauncherLog -Value $line -Encoding UTF8 } catch { }
  }
}

function Show-Message([string]$Text, [string]$Kind = 'Information') {
  if (-not $Interactive) {
    Write-Host "[Social Desk] $Text"
    return
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = [System.Windows.Forms.MessageBoxIcon]::$Kind
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Social Desk', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
  } catch {
    Write-Host "[Social Desk] $Text"
  }
}

function Read-SmallFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return ([System.IO.File]::ReadAllText($Path)).Trim() } catch { return $null }
}

function Get-OurNodeProcesses {
  # Every node.exe started from this installation (normally one), whatever pid.txt says.
  try {
    return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $NodeExe, [System.StringComparison]::OrdinalIgnoreCase) })
  } catch {
    return @()
  }
}

function Test-ProcessAlive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

try {
  $stopped = @()
  $targets = @{}

  $pidText = Read-SmallFile $PidFile
  $recordedPid = 0
  if ($pidText -and [int]::TryParse($pidText, [ref]$recordedPid)) {
    $targets[$recordedPid] = $true
  }
  foreach ($process in Get-OurNodeProcesses) {
    $targets[[int]$process.ProcessId] = $true
  }

  $ours = @(Get-OurNodeProcesses | ForEach-Object { [int]$_.ProcessId })
  foreach ($targetPid in @($targets.Keys)) {
    if ($ours -notcontains $targetPid) {
      if (Test-ProcessAlive $targetPid) {
        Write-LauncherLog "el PID $targetPid ya no es Social Desk (PID reutilizado); no se toca"
      }
      continue
    }
    Write-LauncherLog "deteniendo el proceso $targetPid"
    & taskkill.exe /PID $targetPid /T /F 2>&1 | Out-Null
    $stopped += $targetPid
  }

  # Wait until the stopped processes are really gone (taskkill returns before the process object is released).
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $alive = @($stopped | Where-Object { Test-ProcessAlive $_ })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  $stillAlive = @($stopped | Where-Object { Test-ProcessAlive $_ })
  if ($stillAlive.Count -gt 0) {
    Write-LauncherLog "ERROR: no se pudo detener: $($stillAlive -join ', ')"
    Show-Message "No se pudo detener Social Desk (proceso $($stillAlive -join ', ')). Reinicia Windows." 'Error'
    exit 1
  }

  # Remove the instance lock only when it names a process this script just stopped (provably not running anymore).
  $lockText = Read-SmallFile $LockFile
  if ($lockText) {
    $lockPid = 0
    try { $lockPid = [int](($lockText | ConvertFrom-Json).pid) } catch { $lockPid = 0 }
    if ($lockPid -gt 0 -and $stopped -contains $lockPid -and -not (Test-ProcessAlive $lockPid)) {
      Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
      Write-LauncherLog "bloqueo de instancia liberado (PID $lockPid)"
    }
  }

  foreach ($file in @($PidFile, $PortFile)) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  }

  if ($stopped.Count -gt 0) {
    Write-LauncherLog 'Social Desk se detuvo'
    Show-Message 'Social Desk se detuvo.'
  } else {
    Write-LauncherLog 'Social Desk no estaba abierto'
    Show-Message 'Social Desk no estaba abierto.'
  }
  exit 0
} catch {
  Write-LauncherLog "ERROR: $($_.Exception.Message)"
  Show-Message "No se pudo detener Social Desk: $($_.Exception.Message)" 'Error'
  exit 1
}
