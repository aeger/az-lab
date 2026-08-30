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

Do **not** put the token in `claude_desktop_config.json`. That file is mode 666
under a OneDrive-synced profile, and any MCP server with filesystem access can
read it.

Use `mcp-remote`'s `--header-file` (verified present in 0.8.2 —
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

Rotating `AIP_SECRET` is therefore not required, and is the more disruptive
option since it invalidates every agent's token at once. Only do that if the
secret itself is suspected exposed, rather than one token.

Raising `AIP_MAX_TTL_DAYS` re-admits every over-long token still in circulation.
Treat it as a security control, not a convenience knob.

## Refresh

30-day tokens need a refresh path. There is no automated one yet, because the
signing secret lives on svc-podman-01 and pushing to the Windows box is
unreliable (see the `atlas-windows-reachability-and-router-dead-letter-bug`
note). Until that is solved, refresh is manual:

1. On svc-podman-01, re-run the mint command above.
2. Copy the header file to the desktop, replacing the old one.
3. Restart Claude Desktop.

When a token lapses, atlas does not break — it degrades to unattributed writes,
and the server logs `[aip] invalid/expired JWT presented`. Watch that line.

## Verifier hardening (v5.22.0)

`verifyAipJwt` now additionally requires: `alg` is exactly `HS256`; `iss`
matches `AIP_ISSUER`; both `exp` and `iat` are present and numeric (an
`exp`-less token was previously a permanent credential); `iat` is not in the
future; `nbf` is honoured if present; the lifetime is within the ceiling.
Signature comparison is `timingSafeEqual` rather than `!==`.
