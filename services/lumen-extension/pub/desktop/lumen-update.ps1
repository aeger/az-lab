<#
  Lumen auto-updater (Windows desktop / Atlas)
  ---------------------------------------------
  Polls the az-lab static server for a new Lumen build. If the published
  checksum differs from what's installed, it downloads + verifies + mirrors
  the new build into C:\lumen-latest and raises a Sentinel notification
  ("restart Edge") that also pings Discord.

  Edge loads C:\lumen-latest as an UNPACKED extension. Edge only re-reads the
  files at browser launch (or a manual Reload in edge://extensions), so this
  script refreshes the files and tells Jeff a restart is needed - it cannot
  force Edge to reload on its own.

  Runs unattended via Scheduled Task (see install-lumen-updater.ps1).
#>
#requires -version 5
$ErrorActionPreference = 'Stop'

# --- config ---------------------------------------------------------------
$Dst         = 'C:\lumen-latest'
$BaseUrl     = 'https://lumen.az-lab.dev'
$ZipUrl      = "$BaseUrl/lumen-dist.zip"
$ShaUrl      = "$BaseUrl/lumen-dist.zip.sha256"
$VerUrl      = "$BaseUrl/version.txt"
$Sentinel    = 'https://sentinel-api.az-lab.dev/api/notifications'
$SentinelKey = 'sentinel-c81bbb17bb17df0f46787983da69bcb40c7779a9e1292376'  # LAN-only key
$StateFile   = Join-Path $Dst '.installed.sha256'
# --------------------------------------------------------------------------

# PS 5.1: force TLS 1.2 and skip the IE-engine dependency
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. What does the server have?
$remoteSha = (Invoke-WebRequest $ShaUrl -UseBasicParsing).Content.Trim().ToLower()
$remoteVer = (Invoke-WebRequest $VerUrl -UseBasicParsing).Content.Trim()

# 2. What's installed?
$localSha = if (Test-Path $StateFile) { (Get-Content $StateFile -Raw).Trim().ToLower() } else { '' }
if ($remoteSha -eq $localSha -and (Test-Path (Join-Path $Dst 'manifest.json'))) {
    Write-Host "Lumen already current (v$remoteVer, $($remoteSha.Substring(0,12)))."
    exit 0
}

# 3. Download + verify checksum
$tmpZip = Join-Path $env:TEMP 'lumen-dist.zip'
Invoke-WebRequest $ZipUrl -OutFile $tmpZip -UseBasicParsing
$dlSha = (Get-FileHash $tmpZip -Algorithm SHA256).Hash.ToLower()
if ($dlSha -ne $remoteSha) { throw "Checksum mismatch: downloaded $dlSha != published $remoteSha" }

# 4. Extract to staging, then mirror into $Dst.
#    /MIR removes files dropped from the new build; /XF keeps our state file.
#    Mirroring (vs deleting $Dst outright) is gentler on a folder Edge has open.
$stage = Join-Path $env:TEMP 'lumen-stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null
Expand-Archive -Path $tmpZip -DestinationPath $stage -Force
if (-not (Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst | Out-Null }
robocopy $stage $Dst /MIR /NJH /NJS /NFL /NDL /XF .installed.sha256 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

# 5. Record installed state
Set-Content -Path $StateFile -Value $remoteSha -NoNewline

# 6. Tell Sentinel (shows in the feed + Discord ping via discord_notify)
$payload = @{
    title    = "Lumen updated to v$remoteVer - restart Edge"
    body     = "Local files at $Dst were refreshed to v$remoteVer. Restart Edge (or hit Reload in edge://extensions) to load the new build."
    severity = 'warning'
    category = 'lumen-update'
    sourceId = "lumen:$remoteSha"
    metadata = @{ discord_notify = $true; version = $remoteVer; sha256 = $remoteSha; host = $env:COMPUTERNAME }
} | ConvertTo-Json -Depth 5

try {
    Invoke-RestMethod -Uri $Sentinel -Method Post `
        -Headers @{ 'X-Sentinel-Key' = $SentinelKey } `
        -ContentType 'application/json' -Body $payload | Out-Null
    Write-Host "Updated to v$remoteVer and notified Sentinel."
} catch {
    Write-Warning "Updated to v$remoteVer but Sentinel notify failed: $($_.Exception.Message)"
}
