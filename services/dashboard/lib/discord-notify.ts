// Server-side Discord notification helper — no auth cookie required
// Used internally by API routes when tasks enter pending_jeff_action / review_needed

const DISCORD_API = 'https://discord.com/api/v10'

export interface JeffNotifyOpts {
  title: string
  taskId: string
  status: 'pending_jeff_action' | 'review_needed'
  contextSummary?: string | null
  actionRequired?: string | null
}

const STATUS_LABEL: Record<string, string> = {
  pending_jeff_action: '🔔 Action Required',
  review_needed: '👁️ Review Needed',
}

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
const recentNotifications = new Map<string, number>()

export async function notifyJeff(opts: JeffNotifyOpts): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  const channelId = process.env.DISCORD_CHANNEL_ID
  if (!token || !channelId) return

  // Rate-limit: skip if same task was notified in the last 5 minutes
  const now = Date.now()
  const lastNotified = recentNotifications.get(opts.taskId)
  if (lastNotified && now - lastNotified < NOTIFY_COOLDOWN_MS) return
  recentNotifications.set(opts.taskId, now)

  // Clean up old entries
  for (const [id, ts] of recentNotifications) {
    if (now - ts > NOTIFY_COOLDOWN_MS * 2) recentNotifications.delete(id)
  }

  const label = STATUS_LABEL[opts.status] ?? '🔔 Attention'
  const shortId = opts.taskId.slice(0, 8)

  const lines = [
    `**${label}** — \`${opts.status.replace(/_/g, ' ')}\``,
    `**Task:** ${opts.title}`,
    `**ID:** \`${shortId}...\``,
  ]
  if (opts.contextSummary) lines.push(`**Summary:** ${opts.contextSummary}`)
  if (opts.actionRequired) lines.push(`**Action:** ${opts.actionRequired}`)
  lines.push('— via JeffLoop dashboard · home.az-lab.dev')

  const content = lines.join('\n')

  try {
    await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })
  } catch {
    // Best-effort — never throw
  }
}
