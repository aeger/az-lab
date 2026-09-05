# discord-plugin-patch

Local fixes to the official Discord channel plugin
(`~/.claude/plugins/cache/claude-plugins-official/discord/<ver>/server.ts`).

The plugin cache is **overwritten on every plugin update**, which silently drops
these. After any update:

```sh
python3 ~/azlab/infrastructure/discord-plugin-patch/apply.py
systemctl --user restart claude-discord.service
```

`apply.py` is idempotent — re-running on a patched file prints `already patched`
and changes nothing. It refuses to apply if an anchor no longer matches exactly,
so an upstream rewrite fails loudly instead of half-patching.

## Why these exist

On 2026-09-04 the bridge session's `plugin:discord:discord` MCP server dropped
ten minutes after startup. For the next eleven hours every question asked in
Discord got a `🔄 Working on it…` and no answer. systemd reported the unit
healthy; the watchdog canary reported "alive, idle" every ten minutes.

Two independent faults produced that.

### 1. `inbound-ownership`

`client.login(TOKEN)` ran unconditionally, so **every** claude process with the
plugin installed opened its own Discord gateway on the same bot token — task
queue workers, research runs, ad-hoc sessions. Discord fans `MESSAGE_CREATE` out
to all of them. An unrelated worker session won Jeff's messages, posted the
interim ack, delivered the MCP notification into *itself*, and exited a few
minutes later. No session ever rendered the message.

Now only a session started with `--channels` listens, and only one of those at a
time (`~/.claude/channels/discord/inbound.lock`). Outbound tools are untouched —
ad-hoc sessions do legitimately call `reply`, so every instance still logs in.

### 2. `honest-ack`

`🔄 Working on it…` was posted before delivery, unconditionally, and only
`reply()` ever removed it. A message that nothing was working on kept a
permanent ack. It has to be posted first — its id travels in the notification
meta — so instead the claim is now retracted or escalated:

| what happens | what the ack becomes |
|---|---|
| delivery to the session throws | `⚠️ Not delivered to Claude — nothing is working on this. Please re-send.` |
| delivered, nothing comes back for 5 min | `⚠️ No response after 5 minutes — the bridge may be wedged.` |
| model calls `react` / `edit_message` | 5-minute clock restarts (sign of life) |
| model calls `reply` | interim deleted, as before |

### 3. `typing-leak`

Pre-existing local fix, folded in: clear a leaked typing interval before
starting a new one, and auto-cancel after 90s so a missed `reply()` doesn't
leave "Wren is typing" on forever.

## Related

The other half of the 2026-09-04 fix is in `services/watchdog` —
`src/channel-health.ts` asserts the bridge still has a live Discord MCP
descendant, which is the thing the canary structurally cannot see.
