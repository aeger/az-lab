# AIP tokens — minting, scoping, storage, rotation

Server: `memory-mcp.az-lab.dev` · introduced in v5.22.0 (2026-08-30)

## What an AIP token is, and what it is not

AIP is **attribution, not admission.**

Both MCP services sit behind Traefik's `lan-allow@file` middleware and nothing
else. Any caller on the LAN can `POST /mcp` with no `Authorization` header at
all and reach all 32 tools. Verified this on 2026-08-30: an unauthenticated
initialize returns HTTP 200.

So a leaked AIP token does **not** grant access that the holder lacked — if they
can reach the endpoint, they already had access. What it grants is a *trusted
identity*: the server stamps `source` / `updated_by` from the verified `sub`
rather than from a client-supplied string, and that stamp feeds the trust lane
in hybrid recall. The real consequence of disclosure is **attribution forgery** —
writing memories that look like they came from `atlas`, and are weighted
accordingly on read.

That is a narrower risk than "full memory-server access," but it is not a small
one: poisoning the trust lane is exactly how a memory system gets steered.

If you want actual admission control, the fix is a Traefik middleware
(forward-auth to Authelia, or a header check) in front of the route — not a
bigger JWT. That is not currently deployed.

## Minting

```bash
cd ~/azlab/services/memory-mcp-server
node mint-aip-token.mjs --sub atlas --ttl-days 30 \
  --scope "memory:read memory:write" \
  --out ~/.secret-drop/atlas-aip-header.txt
```

The signing secret (`AIP_SECRET`, in `.env`, mode 0600) never leaves
svc-podman-01. Mint here; hand the agent only the resulting header file.
Omit `--out` to print the raw token to stdout instead.

## Scopes

A token with **no** `scope` claim is unrestricted — legacy tokens keep working.
A token **with** one is held to it.

| Scope | Gates |
|---|---|
| `memory:admin` | `forget`, `forget_file`, `delete_skill`, `merge_memories`, `supersede_memory`, `discard_redundant` |
| `ha:control` | `ha_call_service` |
| `memory:*` | wildcard — satisfies both |

Read and write are deliberately **not** enforced. Gating them would be theatre:
an anonymous caller can already read and write. Only the destructive lane and
Home Assistant control are checked, because those are the operations where a
leaked token changes the outcome.

Scopes are pinned at session establishment, not re-checked per request. A token
that expires mid-session keeps the session it opened.

### Why atlas is `memory:read memory:write`

Every AIP-attributed action atlas has ever taken, over the full life of the
365-day token, is `create` (28) and `update` (5) on `memories` — no deletes, no
merges, no skill or HA calls. If atlas later needs the destructive lane or HA
control, re-mint with the extra scope; it is one command and the denial message
names the scope required.

## Storage on the Windows desktop

**As deployed (2026-08-30):** the token lives in
`mcpServers.memory.env.AUTH_HEADER` in the packaged config. That was Jeff's
explicit call for this rotation — a one-key edit to a working config, rather
than an entry-shape change bundled into a security fix. It is fine: the
packaged config sits under `%LOCALAPPDATA%\Packages\…`, which is **outside**
the OneDrive-synced profile, so the original objection (a mode-666 file syncing
to the cloud) does not apply to the real path. It did apply to the Roaming
decoy, which is why that file's copy of the old token was cleared.

The residual exposure is that any MCP server Desktop launches with filesystem
access can read the config, and the token is visible in that process's `env`.
Given the token is `memory:read memory:write` and AIP is attribution-only, the
blast radius is attribution forgery, not access.

**Preferred shape for the next rotation**, which removes the token from the
config entirely — use `mcp-remote`'s `--header-file` (verified present in 0.8.2 —
`readHeaderFile`, `Name: Value` lines, `#` comments):

```json
"memory": {
  "command": "npx",
  "args": [
    "-y", "mcp-remote@0.8.2",
    "https://memory-mcp.az-lab.dev/mcp",
    "--header-file", "C:\\Users\\<user>\\.az-lab\\aip-header.txt"
  ]
}
```

Put the file **outside** the OneDrive-synced tree, then break inheritance and
grant only the owner:

```powershell
icacls "$env:USERPROFILE\.az-lab\aip-header.txt" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

Windows Credential Manager would be stronger, but `mcp-remote` has no hook to
read from it — it would need a wrapper script that fetches the credential and
execs `mcp-remote`, which reintroduces a plaintext argv. The ACL'd header file
is the best fit for what the client actually supports.

## Lifetime ceiling and revocation

The server rejects any token whose own `exp - iat` span exceeds
`AIP_MAX_TTL_DAYS` (default 30), regardless of signature. This is the
revocation path: **the 365-day atlas token stopped verifying the moment v5.22.0
shipped** — no secret rotation, no coordination, no window where both are valid.

### What "rejected" actually means — measured, not inferred

An over-ceiling token **fails open to anonymous, not closed.** Measured against
the live v5.22.0 server on 2026-08-30 with a 365-day token of exactly the shape
the desktop was presenting:

| | over-ceiling token | no `Authorization` header | valid 30d scoped token |
|---|---|---|---|
| `initialize` | HTTP 200 | HTTP 200 | HTTP 200 |
| all 32 tools listed | yes | yes | yes |
| `forget` (destructive lane) | **proceeds** | **proceeds** | **`Denied: … requires "memory:admin"`** |
| server log | `[aip] rejected token … exceeds the 30d ceiling` then `caller unverified` | — | `[aip] verified caller: atlas` |
| `source`/`updated_by` stamp | client-supplied | client-supplied | verified `sub` |

`verifyAipJwt` returns `null`, the request continues with `caller = null`, and
`scopeDenied(null, …)` returns `null` — i.e. **allow**. That is deliberate and
consistent with "AIP is attribution, not admission": an unauthenticated LAN
caller already has the destructive lane, so refusing it to a caller who merely
presented a bad token would gate nothing while breaking the legacy unscoped
tokens the ceiling is meant to retire.

The practical consequence is the opposite of the intuitive reading: an expired
or over-ceiling token does **not** lock the scoped operations down, it silently
un-scopes them. Installing a valid scoped token is what turns the denials **on**.
So after applying a `memory:read memory:write` token, `forget`, `forget_file`,
`delete_skill`, `merge_memories`, `supersede_memory`, `discard_redundant` and
`ha_call_service` start refusing for that caller when they did not before. That
is the intended tightening, not a regression.

Rotating `AIP_SECRET` is therefore not required, and is the more disruptive
option since it invalidates every agent's token at once. Only do that if the
secret itself is suspected exposed, rather than one token.

Raising `AIP_MAX_TTL_DAYS` re-admits every over-long token still in circulation.
Treat it as a security control, not a convenience knob.

## Refresh

Tokens are 30 days. There is no automated rotation, because the signing secret
lives on svc-podman-01 and there is no usable inbound admin path to the Windows
workstation — see "Delivery" below. Refresh is a two-person-minutes manual job:

1. **On svc-podman-01** — mint into the secret drop (never into chat, a task
   `result` field, the agent-bus journal, or a `memories` row):

   ```bash
   cd ~/azlab/services/memory-mcp-server
   node mint-aip-token.mjs --sub atlas --ttl-days 30 \
     --scope "memory:read memory:write" \
     --out ~/.secret-drop/atlas-aip-header.txt
   ```

2. **On the workstation** — copy that file over, close Claude Desktop, and run:

   ```powershell
   # the workstation can reach the VM over SSH (the reverse is not true)
   scp almty1@192.168.1.181:.secret-drop/atlas-aip-header.txt $env:USERPROFILE\Downloads\
   scp almty1@192.168.1.181:azlab/services/memory-mcp-server/desktop/apply-aip-token.ps1 $env:USERPROFILE\Downloads\

   powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\Downloads\apply-aip-token.ps1 `
     -HeaderFile "$env:USERPROFILE\Downloads\atlas-aip-header.txt"
   ```

   `desktop/apply-aip-token.ps1` validates the claims locally (refusing an
   expired or over-ceiling token before it touches anything), backs the config
   up, mutates **only** `mcpServers.memory.env.AUTH_HEADER`, then re-reads and
   rolls back if the server list changed. Add `-WhatIf` to dry-run.

3. Restart Claude Desktop, then confirm on svc-podman-01:

   ```bash
   podman logs --tail 40 az-memory-mcp | grep aip
   # want: [aip] verified caller: atlas scopes=[memory:read memory:write]
   ```

4. Shred the copied header file on both ends.

Set a reminder for ~day 25. When a token lapses atlas does not break — it
degrades to unattributed writes and the server logs `[aip] invalid/expired JWT
presented`. That line is the only symptom, so watch for it.

## Claude Desktop's config path — the packaged-app trap

**Claude Desktop on `desktop-officemain` is an MSIX/Store-packaged app**
(package family `Claude_pzs8sxrjxfjjc`), so its `%APPDATA%` is virtualised. The
config it actually loads is:

```
C:\Users\almty\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

The documented path — `C:\Users\almty\AppData\Roaming\Claude\claude_desktop_config.json`
— is a **stale decoy**. Editing it has no effect on Desktop whatsoever.

This retroactively explains the 2026-07-28 "hand-edits never survive, use the
GUI" conclusion recorded in the *Register an MCP Server for Atlas* skill and in
the `Atlas MCP config — Windows workstation` memory. The edits were not being
reverted by the app; **they were landing in a file Desktop had stopped reading**
when it became a packaged app. Hand edits to the Packages path do survive.

Anything that touches this file must target the Packages path. As of 2026-08-30
no automation on svc-podman-01 writes either path — `atlas-helper`'s
`config.json` is its own unrelated file at `C:\Tools\atlas-helper\config.json`
— so this is a documentation trap, not a code one. Keep it that way.

The still-valid half of the 2026-07-28 lesson: **a missing config must ABORT,
never "create fresh."** Inventing a config is how that attempt nearly wiped the
gmail / agent-bus / discord-azlab entries. `apply-aip-token.ps1` aborts.

## Delivery — why the token cannot be pushed from the lab

Inbound to `192.168.1.254` (the workstation), measured 2026-08-30: SSH 22 and
RDP 3389 closed, WinRM-HTTPS 5986 closed; SMB 445 and WinRM-HTTP 5985 are
**open but authenticated** (`/wsman` → HTTP 401) and no lab-held credential
opens either. So svc-podman-01 cannot write the desktop's config itself.

(This corrects the `atlas-windows-reachability-and-router-dead-letter-bug` note
of 2026-08-29, which recorded 445 and 5985 as absent. They are listening; what
is missing is a credential, not a service. A future automated refresh would
most cheaply be built the other way round — a workstation-side scheduled task
that pulls, matching the `lumen-update.ps1` poll pattern — rather than by
provisioning inbound WinRM.)

## Verifier hardening (v5.22.0)

`verifyAipJwt` now additionally requires: `alg` is exactly `HS256`; `iss`
matches `AIP_ISSUER`; both `exp` and `iat` are present and numeric (an
`exp`-less token was previously a permanent credential); `iat` is not in the
future; `nbf` is honoured if present; the lifetime is within the ceiling.
Signature comparison is `timingSafeEqual` rather than `!==`.
