<#
  atlas-tray.ps1 - system-tray front end for the Atlas Relay helper.

  Runs helper.mjs as a child process and puts an icon in the notification area
  so the helper is visible and controllable instead of being an invisible
  background task. Uses only WinForms (built into Windows PowerShell 5.1) -
  no npm packages, no BurntToast required.

  Tray icon states:
    green  = connected to Supabase Realtime and idle
    blue   = busy (a claude session is running right now)
    red    = disconnected / helper not running

  Right-click menu: Status, Open Log, Open Config Folder, Restart Helper,
  Toggle Auto-Execute Tasks, Exit.

  Balloon notifications fire whenever the helper records a new event
  (notify_seq in status.json), so toasts work with zero extra install.

  Launched by the Scheduled Task registered in install-atlas-helper.ps1:
    powershell.exe -STA -NoProfile -WindowStyle Hidden -File atlas-tray.ps1
#>
#requires -version 5
param(
  [string]$HelperDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$HelperJs   = Join-Path $HelperDir 'helper.mjs'
$StatusPath = Join-Path $HelperDir 'status.json'
$ConfigPath = Join-Path $HelperDir 'config.json'
$LogPath    = Join-Path $HelperDir 'helper.log'
$ErrLogPath = Join-Path $HelperDir 'helper.err.log'

if (-not (Test-Path $HelperJs)) { throw "helper.mjs not found in $HelperDir" }

# -- Helper process control ---------------------------------------------------
$script:HelperProc = $null

function Start-Helper {
  Stop-Helper
  # Truncate logs if they get large (keep the tail readable)
  foreach ($p in @($LogPath, $ErrLogPath)) {
    if ((Test-Path $p) -and ((Get-Item $p).Length -gt 5MB)) { Clear-Content $p -ErrorAction SilentlyContinue }
  }
  $script:HelperProc = Start-Process -FilePath 'node.exe' `
    -ArgumentList "`"$HelperJs`"" `
    -WorkingDirectory $HelperDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError  $ErrLogPath `
    -PassThru
}

function Stop-Helper {
  if ($script:HelperProc -and -not $script:HelperProc.HasExited) {
    try { Stop-Process -Id $script:HelperProc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  $script:HelperProc = $null
}

function Get-Status {
  if (-not (Test-Path $StatusPath)) { return $null }
  try { return Get-Content $StatusPath -Raw | ConvertFrom-Json } catch { return $null }
}

# -- Tray icon ----------------------------------------------------------------
# SystemIcons are always present - no icon file to ship or lose.
$IconOk   = [System.Drawing.SystemIcons]::Information
$IconBusy = [System.Drawing.SystemIcons]::Application
$IconBad  = [System.Drawing.SystemIcons]::Error

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $IconBad
$notify.Text = 'Atlas Relay - starting...'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = $menu.Items.Add('Status: starting...')
$miStatus.Enabled = $false
$menu.Items.Add('-') | Out-Null

$miLog = $menu.Items.Add('Open Log')
$miLog.add_Click({
  if (Test-Path $LogPath) { Start-Process notepad.exe $LogPath } else { [System.Windows.Forms.MessageBox]::Show('No log yet.') | Out-Null }
})

$miFolder = $menu.Items.Add('Open Helper Folder')
$miFolder.add_Click({ Start-Process explorer.exe $HelperDir })

$miRestart = $menu.Items.Add('Restart Helper')
$miRestart.add_Click({
  Start-Helper
  $notify.ShowBalloonTip(3000, 'Atlas Relay', 'Helper restarted.', [System.Windows.Forms.ToolTipIcon]::Info)
})

$miAuto = $menu.Items.Add('Auto-execute tasks: ?')
$miAuto.add_Click({
  try {
    $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $new = -not [bool]$cfg.auto_execute_tasks
    if ($null -eq $cfg.PSObject.Properties['auto_execute_tasks']) {
      $cfg | Add-Member -NotePropertyName auto_execute_tasks -NotePropertyValue $new
    } else {
      $cfg.auto_execute_tasks = $new
    }
    # Must be UTF-8 WITHOUT a BOM: Set-Content -Encoding UTF8 on PowerShell 5.1
    # emits one, and Node's JSON.parse throws on a leading BOM - that would
    # break the helper on its next start.
    $json = $cfg | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Start-Helper   # config is read at startup, so the change needs a restart
    $notify.ShowBalloonTip(4000, 'Atlas Relay', "Auto-execute tasks is now $new. Helper restarted.", [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Could not update config: $_") | Out-Null
  }
})

$menu.Items.Add('-') | Out-Null
$miExit = $menu.Items.Add('Exit (stops the helper)')
$miExit.add_Click({
  Stop-Helper
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu

# Double-click shows a status summary
$notify.add_MouseDoubleClick({
  $s = Get-Status
  if ($null -eq $s) {
    [System.Windows.Forms.MessageBox]::Show('Helper has not reported status yet.', 'Atlas Relay') | Out-Null
    return
  }
  $msg = @(
    "Agent:            $($s.agent)"
    "Connected:        $($s.connected)"
    "Busy:             $($s.busy)"
    "Messages handled: $($s.messages_handled)"
    "Tasks handled:    $($s.tasks_handled)"
    "Auto-exec tasks:  $($s.auto_execute_tasks)"
    "Started:          $($s.started_at)"
    "Last event:       $($s.last_event_at)"
    "Last error:       $($s.last_error)"
  ) -join "`n"
  [System.Windows.Forms.MessageBox]::Show($msg, 'Atlas Relay status') | Out-Null
})

# -- Poll status.json, drive icon/tooltip/balloons ----------------------------
$script:LastSeq = -1

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  # Helper died? bring it back - this is the tray's watchdog role.
  if ($script:HelperProc -and $script:HelperProc.HasExited) {
    Start-Helper
    $notify.ShowBalloonTip(4000, 'Atlas Relay', 'Helper exited - restarted automatically.', [System.Windows.Forms.ToolTipIcon]::Warning)
  }

  $s = Get-Status
  $running = $script:HelperProc -and -not $script:HelperProc.HasExited

  if ($null -eq $s -or -not $running) {
    $notify.Icon = $IconBad
    $notify.Text = 'Atlas Relay - helper not running'
    $miStatus.Text = 'Status: helper not running'
    return
  }

  if (-not $s.connected) {
    $notify.Icon = $IconBad
    $state = 'disconnected (retrying)'
  } elseif ($s.busy) {
    $notify.Icon = $IconBusy
    $state = 'busy - claude running'
  } else {
    $notify.Icon = $IconOk
    $state = 'connected'
  }

  # NotifyIcon.Text is capped at 63 characters - keep it short or it throws.
  $short = "Atlas Relay - $state"
  if ($short.Length -gt 62) { $short = $short.Substring(0, 62) }
  $notify.Text = $short
  $miStatus.Text = "Status: $state  |  msgs $($s.messages_handled)  tasks $($s.tasks_handled)"
  $miAuto.Text = "Auto-execute tasks: $($s.auto_execute_tasks)"

  # New event from the helper -> balloon (this is the built-in toast path)
  if ($s.notify_seq -gt $script:LastSeq) {
    if ($script:LastSeq -ge 0 -and $s.notify_title) {
      $notify.ShowBalloonTip(6000, $s.notify_title, $s.notify_body, [System.Windows.Forms.ToolTipIcon]::Info)
    }
    $script:LastSeq = $s.notify_seq
  }
})
$timer.Start()

Start-Helper
$notify.ShowBalloonTip(3000, 'Atlas Relay', 'Helper started and listening.', [System.Windows.Forms.ToolTipIcon]::Info)

# Make sure the child dies with the tray, however we exit.
[System.Windows.Forms.Application]::add_ApplicationExit({ Stop-Helper })
$null = Register-EngineEvent PowerShell.Exiting -Action { Stop-Helper }

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
