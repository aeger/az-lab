<#
  Installs the Atlas Relay helper on this Windows machine.
  - Copies atlas-tray.ps1 + helper.mjs + config.json to C:\Tools\atlas-helper\
    and installs the one npm dependency (ws) there.
  - Registers a Scheduled Task that runs at logon and puts the helper in the
    SYSTEM TRAY (atlas-tray.ps1 supervises helper.mjs, shows status, restarts
    it if it dies, and raises balloon notifications).
  Pattern: install-lumen-updater.ps1 (Lumen auto-updater precedent).

  Re-running this script is safe: it replaces the task and restarts the tray.

  Before running (elevated PowerShell, from this folder):
    1. Copy config.example.json to config.json and fill in the Supabase keys.
    2. Ensure Node is installed:  node --version   (v18+ required)
    3. Toasts work out of the box via the tray. BurntToast is optional:
         Install-Module BurntToast -Scope CurrentUser -Force
#>
#requires -version 5
$ErrorActionPreference = 'Stop'

$ToolDir  = 'C:\Tools\atlas-helper'
$TaskName = 'Atlas Relay Helper'

node --version | Out-Null

if (-not (Test-Path (Join-Path $PSScriptRoot 'config.json'))) {
  throw 'config.json missing - copy config.example.json to config.json and fill in the keys first.'
}

# Stop anything from a previous install before overwriting its files.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'Stopping existing task...'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path -like '*node.exe' } |
  ForEach-Object {
    try {
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
      if ($cl -like '*atlas-helper*helper.mjs*') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
  }

if (-not (Test-Path $ToolDir)) { New-Item -ItemType Directory -Path $ToolDir | Out-Null }
foreach ($f in @('atlas-tray.ps1', 'helper.mjs', 'config.json', 'package.json')) {
  Copy-Item -Path (Join-Path $PSScriptRoot $f) -Destination $ToolDir -Force
}
Push-Location $ToolDir
npm install --no-fund --no-audit ws | Out-Null
Pop-Location
Write-Host "Installed helper -> $ToolDir"

$trayScript = Join-Path $ToolDir 'atlas-tray.ps1'

# -STA is required for WinForms (the tray icon); -WindowStyle Hidden keeps the
# PowerShell console out of the way. The tray owns the node child process.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`"" `
    -WorkingDirectory $ToolDir

$trigger = New-ScheduledTaskTrigger -AtLogOn

# A tray app needs an interactive desktop, so this runs as the logged-on user.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Atlas realtime Relay listener (system tray) - receives agent messages/tasks from Supabase Realtime, notifies Jeff, spawns claude -p. See azlab/services/atlas-helper.'

Write-Host "Scheduled task '$TaskName' registered (at logon, tray, restart-on-failure)."
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $TaskName
Write-Host ''
Write-Host 'Done. Look for the Atlas Relay icon in the system tray (check the'
Write-Host 'hidden-icons chevron, and drag it onto the taskbar to pin it).'
Write-Host '  Double-click the icon = status summary'
Write-Host '  Right-click           = log, restart, auto-execute toggle, exit'
