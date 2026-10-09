<#
.SYNOPSIS
  Starts Social Desk (if it is not already running) and opens it in the default browser.

.DESCRIPTION
  Windows PowerShell 5.1 compatible. Installed layout (see packaging/windows/README.md):
    <install>\node\node.exe, <install>\app\scripts\start.mjs, <install>\launcher\launch.ps1 (this file)
  User folders (kept on uninstall): %LOCALAPPDATA%\SocialDesk\{data,logs,run} (SOCIAL_DESK_HOME overrides the base).

  1. If this app already answers /api/health on the port saved in run\port.txt, only open the browser.
  2. If the PID in run\pid.txt is still this app starting up, wait for it instead of starting a second one.
  3. If the instance lock in data\ names a PID that now belongs to another program (Windows reuses PIDs and the app
     cannot prove it is stale there), remove that stale lock. A lock owned by a live Social Desk is never touched.
  4. Pick port 3000, or the first free port 3001-3020, start node hidden with logs in logs\, wait for /api/health.
  On failure: message box with the log path and the last log lines (or console output with -Quiet), exit code 1.

.PARAMETER NoBrowser
  Do not open the browser (CI / smoke test).
.PARAMETER Quiet
  No dialog boxes: messages go to the console. Also enabled by SOCIAL_DESK_NONINTERACTIVE=1.
.PARAMETER TimeoutSeconds
  How long to wait for /api/health (default 90).
#>
[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Quiet,
  [int]$TimeoutSeconds = 90
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$LauncherDir = $PSScriptRoot
$InstallDir = Split-Path -Parent $LauncherDir
$NodeExe = Join-Path $InstallDir 'node\node.exe'
$AppDir = Join-Path $InstallDir 'app'
$StartScript = Join-Path $AppDir 'scripts\start.mjs'

$HomeDir = if ($env:SOCIAL_DESK_HOME) { $env:SOCIAL_DESK_HOME } else { Join-Path $env:LOCALAPPDATA 'SocialDesk' }
$DataDir = Join-Path $HomeDir 'data'
$LogDir = Join-Path $HomeDir 'logs'
$RunDir = Join-Path $HomeDir 'run'
$PidFile = Join-Path $RunDir 'pid.txt'
$PortFile = Join-Path $RunDir 'port.txt'
$LockFile = Join-Path $DataDir '.application-owner.json'
$LauncherLog = Join-Path $LogDir 'launcher.log'

$PreferredPort = 3000
$FallbackPorts = 3001..3020
$LogRetentionDays = 14
$Interactive = -not ($Quiet -or $env:SOCIAL_DESK_NONINTERACTIVE -eq '1')

function Write-LauncherLog([string]$Message) {
  $line = '{0} [launch] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try { Add-Content -LiteralPath $LauncherLog -Value $line -Encoding UTF8 } catch { }
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

function Write-SmallFile([string]$Path, [string]$Value) {
  # ASCII without BOM so any tool (and stop.ps1) reads a plain number.
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.Encoding]::ASCII)
}

function Remove-RunFiles {
  foreach ($file in @($PidFile, $PortFile)) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  }
}

function Test-Health([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    $body = $response.Content | ConvertFrom-Json
    return ($response.StatusCode -eq 200 -and $body.status -eq 'ok' -and $body.ready -eq $true)
  } catch {
    return $false
  }
}

function Test-PortFree([int]$Port) {
  # 1) Anything listening on this port on any address (IPv4/IPv6) means busy: the browser opens "localhost",
  #    which may resolve to ::1 and reach another program.
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    if ($listeners.Count -gt 0) { return $false }
  } catch {
    # No listener found (the cmdlet throws when nothing matches) or the cmdlet is unavailable.
  }
  # 2) The address the app binds must be bindable (also catches ports reserved by Windows/Hyper-V).
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}

function Get-ProcessInfo([int]$ProcessId) {
  try {
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-IsOurNode($ProcessInfo) {
  if (-not $ProcessInfo -or -not $ProcessInfo.ExecutablePath) { return $false }
  return [string]::Equals($ProcessInfo.ExecutablePath, $NodeExe, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-LogTail([string[]]$Paths, [int]$Lines = 15) {
  $tail = @()
  foreach ($path in $Paths) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      $tail += @(Get-Content -LiteralPath $path -Tail $Lines -ErrorAction SilentlyContinue)
    }
  }
  if ($tail.Count -gt $Lines) { $tail = $tail[($tail.Count - $Lines)..($tail.Count - 1)] }
  return ($tail -join [Environment]::NewLine)
}

function Stop-Tree([int]$ProcessId) {
  & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
}

function Open-App([int]$Port) {
  if ($NoBrowser) {
    Write-LauncherLog "Social Desk listo en http://localhost:$Port (sin abrir el navegador)"
    return
  }
  Write-LauncherLog "abriendo http://localhost:$Port"
  Start-Process "http://localhost:$Port"
}

function Wait-Healthy([int]$Port, $Process, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $Port) { return 'ok' }
    if ($Process -and $Process.HasExited) { return 'exited' }
    Start-Sleep -Milliseconds 500
  }
  if (Test-Health $Port) { return 'ok' }
  return 'timeout'
}

function Exit-WithError([string]$Text) {
  Write-LauncherLog "ERROR: $Text"
  Show-Message $Text 'Error'
  exit 1
}

try {
  foreach ($dir in @($HomeDir, $DataDir, $LogDir, $RunDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  }
  Write-LauncherLog "inicio: instalación=$InstallDir datos=$DataDir"

  # Log retention: delete logs older than 14 days.
  Get-ChildItem -LiteralPath $LogDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogRetentionDays) -and $_.FullName -ne $LauncherLog } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  foreach ($required in @($NodeExe, $StartScript)) {
    if (-not (Test-Path -LiteralPath $required)) {
      Exit-WithError ("La instalación de Social Desk está incompleta: falta $required.`r`n`r`n" +
        'Vuelve a ejecutar el instalador.')
    }
  }

  # 1. Already running and healthy: just open it.
  $savedPortText = Read-SmallFile $PortFile
  $savedPort = 0
  if ($savedPortText -and [int]::TryParse($savedPortText, [ref]$savedPort) -and (Test-Health $savedPort)) {
    Write-LauncherLog "ya estaba abierto en el puerto $savedPort"
    Open-App $savedPort
    exit 0
  }

  # 2. Our process is still starting up: wait for it instead of starting a second instance.
  $savedPidText = Read-SmallFile $PidFile
  $savedPid = 0
  if ($savedPidText -and [int]::TryParse($savedPidText, [ref]$savedPid)) {
    $info = Get-ProcessInfo $savedPid
    if ((Test-IsOurNode $info) -and $savedPort -gt 0) {
      Write-LauncherLog "el proceso $savedPid sigue arrancando; esperando"
      $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
      if ((Wait-Healthy $savedPort $process $TimeoutSeconds) -eq 'ok') {
        Open-App $savedPort
        exit 0
      }
      Write-LauncherLog "el proceso $savedPid no respondió; se detiene para empezar de nuevo"
      Stop-Tree $savedPid
      Start-Sleep -Seconds 1
    }
  }
  Remove-RunFiles

  # 3. Instance lock left in data\. The app reclaims it by itself when the recorded PID is dead; Windows reuses PIDs,
  #    so a lock whose PID now belongs to an unrelated program is removed here. A Social Desk owner is never touched.
  $lockText = Read-SmallFile $LockFile
  if ($lockText) {
    $lockPid = 0
    try { $lockPid = [int](($lockText | ConvertFrom-Json).pid) } catch { $lockPid = 0 }
    $owner = if ($lockPid -gt 0) { Get-ProcessInfo $lockPid } else { $null }
    if ($owner) {
      $commandLine = [string]$owner.CommandLine
      if ((Test-IsOurNode $owner) -or ($commandLine -match 'start\.mjs|server\.ts')) {
        # Running Social Desk whose run files were lost: find it and open it.
        foreach ($candidate in @($PreferredPort) + $FallbackPorts) {
          if (Test-Health $candidate) {
            Write-SmallFile $PidFile ([string]$lockPid)
            Write-SmallFile $PortFile ([string]$candidate)
            Write-LauncherLog "ya estaba abierto (PID $lockPid) en el puerto $candidate"
            Open-App $candidate
            exit 0
          }
        }
        Exit-WithError ("Social Desk ya se está ejecutando (proceso $lockPid) con la misma carpeta de datos, " +
          "pero no responde.`r`n`r`nUsa el acceso «Detener Social Desk» y vuelve a abrirlo. " +
          "Si sigue igual, reinicia Windows.`r`n`r`nRegistro: $LauncherLog")
      } elseif ($owner.Name -ieq 'node.exe' -and -not $commandLine) {
        Write-LauncherLog "el bloqueo pertenece al PID $lockPid (node.exe, sin acceso a su línea de comandos); no se toca"
      } else {
        Write-LauncherLog "bloqueo obsoleto: el PID $lockPid ahora es $($owner.Name); se elimina el bloqueo"
        Remove-Item -LiteralPath $LockFile -Force
      }
    }
  }

  # 4. Choose a port.
  $port = 0
  foreach ($candidate in @($PreferredPort) + $FallbackPorts) {
    if (Test-PortFree $candidate) { $port = $candidate; break }
    Write-LauncherLog "puerto $candidate ocupado"
  }
  if ($port -eq 0) {
    Exit-WithError ("No hay un puerto libre entre $PreferredPort y $($FallbackPorts[-1]). " +
      'Cierra otros programas que usen esos puertos y vuelve a intentarlo.')
  }

  # 5. Start the server hidden. Start-Process cannot send stdout and stderr to the same file: two files per start.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outLog = Join-Path $LogDir "server-$stamp.log"
  $errLog = Join-Path $LogDir "server-$stamp.err.log"
  $env:LOCAL_SOCIAL_DATA_DIR = $DataDir
  $env:PORT = [string]$port
  $env:NEXT_TELEMETRY_DISABLED = '1'
  Write-LauncherLog "iniciando en el puerto $port (registro: $outLog)"
  $process = Start-Process -FilePath $NodeExe -ArgumentList @("`"$StartScript`"") -WorkingDirectory $AppDir `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  $null = $process.Handle # keeps the handle so ExitCode is available after exit
  Write-SmallFile $PidFile ([string]$process.Id)
  Write-SmallFile $PortFile ([string]$port)

  $result = Wait-Healthy $port $process $TimeoutSeconds
  if ($result -eq 'ok') {
    Write-LauncherLog "listo (PID $($process.Id), puerto $port)"
    Open-App $port
    exit 0
  }

  # 6. Failure: stop what we started and explain.
  if (-not $process.HasExited) { Stop-Tree $process.Id }
  Remove-RunFiles
  Start-Sleep -Milliseconds 500
  $tail = Get-LogTail @($outLog, $errLog) 15
  $reason = if ($result -eq 'exited') { "el servidor se cerró (código $($process.ExitCode))" } else { "no respondió en $TimeoutSeconds segundos" }
  Write-LauncherLog "fallo: $reason"
  Write-LauncherLog "últimas líneas del registro:`r`n$tail"
  $advice = ''
  if ($tail -match 'already running or ownership is uncertain|recovery is uncertain') {
    $advice = "`r`n`r`nOtra instancia de Social Desk parece estar usando la carpeta de datos. Usa «Detener Social Desk» " +
      "o reinicia Windows. Si estás seguro de que no hay ninguna abierta, borra los archivos de $RunDir y el archivo " +
      "$LockFile, y vuelve a abrir Social Desk."
  } elseif ($tail -match 'EADDRINUSE') {
    $advice = "`r`n`r`nEl puerto $port quedó ocupado por otro programa. Vuelve a intentarlo."
  }
  Exit-WithError ("Social Desk no pudo iniciar: $reason.$advice`r`n`r`nRegistro: $outLog`r`n`r`nÚltimas líneas:`r`n$tail")
} catch {
  Exit-WithError ("Error inesperado al iniciar Social Desk: $($_.Exception.Message)`r`n`r`nRegistro: $LauncherLog")
}
