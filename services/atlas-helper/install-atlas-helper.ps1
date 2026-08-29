<#
  Installs the Atlas Relay helper on this Windows machine.
  - Copies helper.mjs + config.json + node_modules(ws) to C:\Tools\atlas-helper\
  - Registers a Scheduled Task that runs at logon (no time limit) and restarts
    on failure, so the helper holds a live Supabase Realtime connection 24/7.
  Pattern: install-lumen-updater.ps1 (Lumen auto-updater precedent).

  Before running (elevated PowerShell, from this folder in the repo checkout):
    1. Copy config.example.json to config.json and fill in the Supabase keys
       (same values Atlas already uses; ask Wren if unsure).
    2. Ensure Node is installed:  node --version   (v18+ required)
    3. Optional toasts:           Install-Module BurntToast -Scope CurrentUser
#>
#requires -version 5
$ErrorActionPreference = 'Stop'

$ToolDir  = 'C:\Tools\atlas-helper'
$TaskName = 'Atlas Relay Helper'

node --version | Out-Null

if (-not (Test-Path (Join-Path $PSScriptRoot 'config.json'))) {
  throw 'config.json missing — copy config.example.json to config.json and fill in the keys first.'
}

if (-not (Test-Path $ToolDir)) { New-Item -ItemType Directory -Path $ToolDir | Out-Null }
Copy-Item -Path (Join-Path $PSScriptRoot 'helper.mjs')  -Destination $ToolDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'config.json') -Destination $ToolDir -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'package.json') -Destination $ToolDir -Force
Push-Location $ToolDir
npm install --no-fund --no-audit ws | Out-Null
Pop-Location
Write-Host "Installed helper -> $ToolDir"

$action = New-ScheduledTaskAction -Execute 'node.exe' `
    -Argument "`"$ToolDir\helper.mjs`"" -WorkingDirectory $ToolDir

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -Force `
    -Description 'Atlas realtime Relay listener — receives agent messages/tasks from Supabase Realtime, toasts Jeff, spawns claude -p. See azlab/services/atlas-helper.'

Write-Host "Scheduled task '$TaskName' registered (at logon, restart-on-failure)."
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Done. Verify with: Get-ScheduledTask -TaskName "Atlas Relay Helper" | Get-ScheduledTaskInfo'
