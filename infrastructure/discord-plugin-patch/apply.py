#!/usr/bin/env python3
"""
Re-appliable local patch for the official Discord channel plugin.

The plugin cache (~/.claude/plugins/cache/.../discord/<ver>/server.ts) is
overwritten whenever the plugin updates, which silently drops local fixes.
Run this after any plugin update:

    python3 ~/azlab/infrastructure/discord-plugin-patch/apply.py

Idempotent — re-running on an already-patched file is a no-op.

Patches
-------
1. inbound-ownership  Every claude session with this plugin installed spawns its
   own copy of the MCP server, and each one used to log into the gateway AND
   listen. Discord fans MESSAGE_CREATE out to all of them, so an unrelated
   task-queue session could win a message meant for the bridge: it posted the
   interim ack, delivered the notification into itself, then exited. Only a
   session started with --channels now listens, and only one of those at a time.
   Outbound tools stay available in every session.

2. honest-ack  "Working on it..." was posted unconditionally, before delivery,
   and only reply() ever removed it. A message nothing was working on kept a
   permanent ack. Delivery failure now retracts it, and five minutes of total
   silence escalates it, so a dead bridge is visible in chat instead of implied.

3. typing-leak  (pre-existing local fix, folded in) clear a leaked typing
   interval before starting a new one; auto-cancel after 90s.

Background: 2026-09-04, the bridge session's MCP server dropped 10 min after
startup and 11 hours of Discord questions were acked by unrelated worker
sessions and never answered.
"""
import re
import sys
from pathlib import Path

CACHE = Path.home() / ".claude/plugins/cache/claude-plugins-official/discord"
MARKER = "// ── Inbound ownership"


def find_server() -> Path:
    versions = sorted(p for p in CACHE.glob("*/server.ts"))
    if not versions:
        sys.exit(f"no server.ts under {CACHE}")
    return versions[-1]


def sub_once(src: str, old: str, new: str, label: str) -> str:
    n = src.count(old)
    if n != 1:
        sys.exit(f"patch {label!r}: expected 1 match of anchor, found {n} — "
                 "upstream changed, re-check the patch by hand")
    return src.replace(old, new, 1)


OWNERSHIP = '''
// ── Inbound ownership ────────────────────────────────────────────────────────
// Every claude session with this plugin installed spawns its own copy of this
// server, and each one used to log into the gateway AND listen. Discord fans
// MESSAGE_CREATE out to all of them, so an unrelated task-queue session could
// win a message meant for the bridge: it posted the interim ack, delivered the
// notification into itself, and exited. On 2026-09-04 that produced 11 hours of
// acked-but-unanswered messages while the bridge sat with no MCP server at all.
//
// Outbound tools stay available everywhere — ad-hoc sessions do legitimately
// call reply. Only *listening* is made exclusive, in two layers:
//   1. eligibility — the session was started with --channels, i.e. it asked to
//      own a channel rather than merely having the plugin installed.
//   2. exclusivity — among eligible sessions, whoever holds the lock listens.
const OWNER_LOCK = join(STATE_DIR, 'inbound.lock')

/** PID of the claude process that spawned us — the socket path carries it. */
function harnessPid(): number | null {
  const m = process.env.CLAUDE_CODE_MESSAGING_SOCKET?.match(/(\\d+)\\.sock$/)
  return m ? Number(m[1]) : null
}

function argvOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\\0').join(' ')
  } catch {}
  try {
    const out = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    return out.stdout || null
  } catch {}
  return null
}

/**
 * Unknown harness or unreadable argv falls through to `true` — upstream
 * behaviour. A wrong guess here would make the bridge deaf, which is worse than
 * the duplicate-listener bug this guards against.
 */
function eligibleForInbound(): boolean {
  const pid = harnessPid()
  if (pid === null) return true
  const argv = argvOf(pid)
  if (argv === null) return true
  return /(^|\\s)--channels(\\s|=)/.test(argv)
}

/** Take the single-listener lock, stealing it if the recorded holder is gone. */
function claimInboundLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
      const fd = openSync(OWNER_LOCK, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch {
      let holder = 0
      try { holder = Number(readFileSync(OWNER_LOCK, 'utf8').trim()) } catch {}
      if (holder === process.pid) return true
      let alive = false
      try { process.kill(holder, 0); alive = true } catch {}
      if (alive) return false
      try { rmSync(OWNER_LOCK) } catch {}
    }
  }
  return false
}

const OWNS_INBOUND = eligibleForInbound() && claimInboundLock()

function releaseInboundLock(): void {
  if (!OWNS_INBOUND) return
  try {
    if (Number(readFileSync(OWNER_LOCK, 'utf8').trim()) === process.pid) rmSync(OWNER_LOCK)
  } catch {}
}
'''

STALL = '''
// A delivered notification proves the harness accepted the message, not that
// the model ever answers. If nothing comes back for this chat at all, say so
// rather than leaving "Working on it…" standing forever — that stale ack is
// exactly what hid an 11-hour outage on 2026-09-04.
const STALL_MS = 300_000
const activeStall = new Map<string, ReturnType<typeof setTimeout>>()

function clearStallWatch(chat_id: string): void {
  const t = activeStall.get(chat_id)
  if (t) { clearTimeout(t); activeStall.delete(chat_id) }
}

/** No-op when there is no interim message to escalate. */
function armStallWatch(chat_id: string): void {
  clearStallWatch(chat_id)
  if (!activeInterim.has(chat_id)) return
  const t = setTimeout(() => {
    activeStall.delete(chat_id)
    void editInterim(
      chat_id,
      '⚠️ No response after 5 minutes — the bridge may be wedged. ' +
      'Nothing has been sent back yet.',
    )
  }, STALL_MS)
  activeStall.set(chat_id, t)
}

async function editInterim(chat_id: string, text: string): Promise<void> {
  const id = activeInterim.get(chat_id)
  if (!id) return
  try {
    const ch = await fetchAllowedChannel(chat_id)
    const m = await (ch as import('discord.js').TextChannel).messages.fetch(id)
    await m.edit(text)
  } catch {}
}

/** Withdraw the "working on it" claim when it turns out to be untrue. */
async function retractAck(chat_id: string, text: string): Promise<void> {
  clearStallWatch(chat_id)
  const typingInterval = activeTyping.get(chat_id)
  if (typingInterval) { clearInterval(typingInterval); activeTyping.delete(chat_id) }
  await editInterim(chat_id, text)
}
'''


NOTIFY_OLD = """  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        chat_id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        interim_message_id,
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
      },
    },
  }).catch(err => {
    process.stderr.write(`discord channel: failed to deliver inbound to Claude: ${err}\\n`)
  })
}
"""

# The interim message is posted before delivery because its id has to travel in
# the meta. That makes it a claim written before the thing it claims is true, so
# the only honest shape is to await the delivery and take the claim back when it
# fails — and to escalate it when the delivery lands but nothing ever answers.
NOTIFY_NEW = """  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id,
          message_id: msg.id,
          user: msg.author.username,
          user_id: msg.author.id,
          ts: msg.createdAt.toISOString(),
          interim_message_id,
          ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
        },
      },
    })
  } catch (err) {
    process.stderr.write(`discord channel: failed to deliver inbound to Claude: ${err}\\n`)
    await retractAck(
      chat_id,
      '⚠️ Not delivered to Claude — nothing is working on this. Please re-send.',
    )
    return
  }
  armStallWatch(chat_id)
}
"""


def main() -> None:
    server = find_server()
    src = server.read_text()

    if MARKER in src:
        print(f"already patched: {server}")
        return

    backup = server.with_suffix(".ts.bak-prepatch")
    if not backup.exists():
        backup.write_text(src)

    # 1. imports
    src = sub_once(
        src,
        "import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync } from 'fs'",
        "import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync, openSync, writeSync, closeSync } from 'fs'\n"
        "import { spawnSync } from 'child_process'",
        "imports",
    )

    # 2. ownership block, right after the Client is constructed
    src = sub_once(
        src,
        "  // DMs arrive as partial channels — messageCreate never fires without this.\n"
        "  partials: [Partials.Channel],\n"
        "})\n",
        "  // DMs arrive as partial channels — messageCreate never fires without this.\n"
        "  partials: [Partials.Channel],\n"
        "})\n" + OWNERSHIP,
        "ownership",
    )

    # 3. stall-watch state and helpers, beside the other per-chat maps
    src = sub_once(
        src,
        "// Tier 2: interim \"working\" message IDs — deleted when Claude sends its reply.\n"
        "const activeInterim = new Map<string, string>()\n",
        "// Tier 2: interim \"working\" message IDs — deleted when Claude sends its reply.\n"
        "const activeInterim = new Map<string, string>()\n" + STALL,
        "stall-helpers",
    )

    # 4. reply() settles the chat — the answer arrived
    src = sub_once(
        src,
        "        // Tier 1: stop typing indicator loop\n"
        "        const typingInterval = activeTyping.get(chat_id)",
        "        // The answer arrived — stand down the stall escalation.\n"
        "        clearStallWatch(chat_id)\n\n"
        "        // Tier 1: stop typing indicator loop\n"
        "        const typingInterval = activeTyping.get(chat_id)",
        "reply-clear-stall",
    )

    # 5. react / edit_message are signs of life — push the deadline out
    src = sub_once(
        src,
        "      case 'react': {\n"
        "        const ch = await fetchAllowedChannel(args.chat_id as string)",
        "      case 'react': {\n"
        "        armStallWatch(args.chat_id as string)\n"
        "        const ch = await fetchAllowedChannel(args.chat_id as string)",
        "react-rearm",
    )
    src = sub_once(
        src,
        "      case 'edit_message': {\n"
        "        const ch = await fetchAllowedChannel(args.chat_id as string)",
        "      case 'edit_message': {\n"
        "        armStallWatch(args.chat_id as string)\n"
        "        const ch = await fetchAllowedChannel(args.chat_id as string)",
        "edit-rearm",
    )

    # 6. gate both inbound listeners
    src = sub_once(
        src,
        "client.on('interactionCreate', async (interaction: Interaction) => {\n"
        "  if (!interaction.isButton()) return",
        "client.on('interactionCreate', async (interaction: Interaction) => {\n"
        "  if (!OWNS_INBOUND) return\n"
        "  if (!interaction.isButton()) return",
        "gate-interaction",
    )
    src = sub_once(
        src,
        "client.on('messageCreate', msg => {\n"
        "  if (msg.author.bot) return",
        "client.on('messageCreate', msg => {\n"
        "  if (!OWNS_INBOUND) return\n"
        "  if (msg.author.bot) return",
        "gate-message",
    )

    # 7. ack only survives a delivery that actually went through
    src = sub_once(src, NOTIFY_OLD, NOTIFY_NEW, "await-notification")

    # 8. say which mode we came up in, and free the lock on the way out
    src = sub_once(
        src,
        "client.once('ready', c => {\n"
        "  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\\n`)\n"
        "})",
        "client.once('ready', c => {\n"
        "  const mode = OWNS_INBOUND ? 'inbound owner' : 'outbound only'\n"
        "  process.stderr.write(`discord channel: gateway connected as ${c.user.tag} (${mode})\\n`)\n"
        "})",
        "ready-log",
    )
    src = sub_once(
        src,
        "  process.stderr.write('discord channel: shutting down\\n')\n",
        "  process.stderr.write('discord channel: shutting down\\n')\n"
        "  releaseInboundLock()\n",
        "shutdown-release",
    )

    server.write_text(src)
    print(f"patched: {server}")
    print(f"backup:  {backup}")


if __name__ == "__main__":
    main()
