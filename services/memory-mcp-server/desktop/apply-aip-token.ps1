<#
  apply-aip-token.ps1 — install a freshly minted AIP token into Claude Desktop's
  REAL MCP config on desktop-officemain, and neutralise the stale decoy config.

  WHY THIS SCRIPT EXISTS
  ----------------------
  Claude Desktop here is an MSIX/Store-packaged app (package family
  Claude_pzs8sxrjxfjjc), so its %APPDATA% is virtualised. The config it actually
  loads is under LocalCache\Roaming, NOT the documented AppData\Roaming path.
  The documented path is a stale decoy: editing it has no effect on Desktop.
  That is what defeated the 2026-07-28 "hand-edits don't survive" attempts —
  the edits were landing in a file Desktop had stopped reading.

  USAGE (run on the Windows workstation, normal user, Claude Desktop CLOSED):
    powershell -ExecutionPolicy Bypass -File .\apply-aip-token.ps1 `
      -HeaderFile "$env:USERPROFILE\Downloads\atlas-aip-header.txt"

  The header file is what mint-aip-token.mjs --out produces on svc-podman-01:
  a single line `Authorization: Bearer <jwt>`. Copy it over, run this, then
  shred the copy. Add -WhatIf to preview without writing.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$HeaderFile,

  [string]$ConfigPath = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json",

  [string]$DecoyPath = "$env:APPDATA\Claude\claude_desktop_config.json",

  # Leave the decoy alone. By default it is overwritten with an empty, clearly
  # labelled stub so the old plaintext token stops sitting on disk.
  [switch]$KeepDecoy
)

$ErrorActionPreference = 'Stop'

# UTF-8 *without* BOM. Set-Content -Encoding UTF8 emits a BOM on PS 5.1 and
# Desktop's JSON parser chokes on it.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonFile($Path, $Object) {
  # -Depth 32: ConvertTo-Json defaults to 2 and would silently flatten the
  # nested mcpServers.<name>.env objects into "System.Object[]" strings.
  $json = $Object | ConvertTo-Json -Depth 32
  [System.IO.File]::WriteAllText($Path, $json, $Utf8NoBom)
}

# ── 1. Read the token ────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $HeaderFile)) { throw "Header file not found: $HeaderFile" }

$headerLine = (Get-Content -LiteralPath $HeaderFile -Raw) -split "`r?`n" |
              Where-Object { $_ -match '^\s*Authorization\s*:' } | Select-Object -First 1
if (-not $headerLine) { throw "No 'Authorization:' line in $HeaderFile" }

$authValue = ($headerLine -replace '^\s*Authorization\s*:\s*', '').Trim()
if ($authValue -notmatch '^Bearer\s+\S+\.\S+\.\S+$') { throw "Header value is not a 'Bearer <jwt>': $HeaderFile" }

# Sanity-check the claims locally so a stale or over-ceiling token is caught
# here rather than degrading silently to unattributed writes at runtime.
$payload = $authValue.Split('.')[1]
switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } }
$claims = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($payload.Replace('-', '+').Replace('_', '/'))
          ) | ConvertFrom-Json
$ttlDays = [math]::Round(($claims.exp - $claims.iat) / 86400, 1)
$expires = [DateTimeOffset]::FromUnixTimeSeconds($claims.exp).ToLocalTime()

Write-Host "Token: sub=$($claims.sub) iss=$($claims.iss) scope=`"$($claims.scope)`" ttl=${ttlDays}d expires=$expires"
if ($ttlDays -gt 30) { throw "Token TTL ${ttlDays}d exceeds the server's 30d ceiling — it would not verify. Re-mint." }
if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -ge $claims.exp) { throw "Token already expired. Re-mint." }

# ── 2. Patch the REAL config ─────────────────────────────────────────────────
# A missing config ABORTS. Never "create fresh": inventing a config is how the
# 2026-07-28 attempt nearly wiped gmail / agent-bus / discord-azlab.
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Real config not found at $ConfigPath — ABORTING rather than creating one. Verify the package family name."
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if (-not $config.mcpServers)        { throw "No mcpServers key in $ConfigPath — refusing to guess at its shape." }
if (-not $config.mcpServers.memory) { throw "No mcpServers.memory entry in $ConfigPath — add it via the Desktop GUI first." }
if (-not $config.mcpServers.memory.env) { throw "mcpServers.memory has no env block — refusing to invent one." }
if ($null -eq $config.mcpServers.memory.env.AUTH_HEADER) { throw "mcpServers.memory.env has no AUTH_HEADER key — refusing to invent one." }

$serversBefore = @($config.mcpServers.PSObject.Properties.Name)
Write-Host "Config servers: $($serversBefore -join ', ')"

if ($PSCmdlet.ShouldProcess($ConfigPath, "update mcpServers.memory.env.AUTH_HEADER")) {
  $backup = "$ConfigPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup
  Write-Host "Backup: $backup"

  # The ONLY mutation. Everything else in the file is round-tripped untouched.
  $config.mcpServers.memory.env.AUTH_HEADER = $authValue
  Write-JsonFile $ConfigPath $config

  # Re-read and confirm nothing else was lost in the round-trip.
  $after = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $serversAfter = @($after.mcpServers.PSObject.Properties.Name)
  if (Compare-Object $serversBefore $serversAfter) {
    Copy-Item -LiteralPath $backup -Destination $ConfigPath -Force
    throw "Server list changed ($($serversAfter -join ', ')) — restored the backup. Do not restart Desktop."
  }
  if ($after.mcpServers.memory.env.AUTH_HEADER -ne $authValue) {
    Copy-Item -LiteralPath $backup -Destination $ConfigPath -Force
    throw "AUTH_HEADER did not round-trip — restored the backup."
  }
  Write-Host "OK: AUTH_HEADER updated, $($serversAfter.Count) servers intact."
}

# ── 3. Neutralise the decoy ──────────────────────────────────────────────────
# It holds an old plaintext token and only the memory entry. If Claude Desktop
# is ever reinstalled unpackaged it would load this partial config and silently
# lose gmail / agent-bus / discord-azlab. Replace it with an inert marker.
if (-not $KeepDecoy -and (Test-Path -LiteralPath $DecoyPath)) {
  if ($PSCmdlet.ShouldProcess($DecoyPath, "overwrite stale decoy config")) {
    Copy-Item -LiteralPath $DecoyPath -Destination "$DecoyPath.stale-$(Get-Date -Format yyyyMMddHHmmss)"
    Write-JsonFile $DecoyPath ([ordered]@{
      _README    = "NOT the config Claude Desktop loads. Desktop is MSIX-packaged (Claude_pzs8sxrjxfjjc) and reads %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json. Edit that one. This file was emptied on 2026-08-30 because it held a stale AIP token and a partial server list."
      _realConfig = "%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"
      mcpServers = [ordered]@{}
    })
    Write-Host "Decoy neutralised: $DecoyPath (old copy kept alongside as .stale-*, delete once you're happy)"
  }
}

Write-Host ""
Write-Host "Now restart Claude Desktop, then on svc-podman-01 confirm attribution:"
Write-Host "  podman logs --tail 40 az-memory-mcp | grep aip"
Write-Host "  expect: [aip] verified caller: atlas scopes=[memory:read memory:write]"
Write-Host "Finally, shred your copy of the header file: Remove-Item '$HeaderFile'"
