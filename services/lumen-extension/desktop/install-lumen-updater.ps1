<#
  Installs the Lumen auto-updater on this Windows machine.
  - Copies lumen-update.ps1 to C:\Tools\lumen-update.ps1 (kept OUTSIDE
    C:\lumen-latest so the /MIR mirror never deletes it).
  - Registers a Scheduled Task that runs at logon and every 4 hours.
  Run from an elevated PowerShell in the desktop\ folder of this repo checkout.
#>
#requires -version 5
$ErrorActionPreference = 'Stop'

$ToolDir    = 'C:\Tools'
$ScriptDst  = Join-Path $ToolDir 'lumen-update.ps1'
$ScriptSrc  = Join-Path $PSScriptRoot 'lumen-update.ps1'
$TaskName   = 'Lumen Auto-Update'

if (-not (Test-Path $ToolDir)) { New-Item -ItemType Directory -Path $ToolDir | Out-Null }
Copy-Item -Path $ScriptSrc -Destination $ScriptDst -Force
Write-Host "Installed updater -> $ScriptDst"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptDst`""

$triggers = @(
    New-ScheduledTaskTrigger -AtLogOn
    $t = New-ScheduledTaskTrigger -Once -At (Get-Date)
    $t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 4)).Repetition
    $t
)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -RunLevel Limited -Force -Description 'Pulls latest Lumen build from lumen.az-lab.dev and notifies Sentinel when Edge needs a restart.'

Write-Host "Scheduled task '$TaskName' registered (at logon + every 4h)."
Write-Host "Running once now to seed the install..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptDst
