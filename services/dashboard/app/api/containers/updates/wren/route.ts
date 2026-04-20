import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const STATE_FILE = join(process.cwd(), 'data', 'update_state.json')

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  try {
    const { container, image, risk, currentVersion, latestVersion } = await req.json()
    if (!container || typeof container !== 'string') {
      return NextResponse.json({ error: 'Missing container' }, { status: 400 })
    }

    const riskLabel = risk ?? 'major'
    const versionLine = (currentVersion || latestVersion)
      ? `\n\nCurrent: \`${currentVersion ?? '?'}\` → Latest: \`${latestVersion ?? 'unknown'}\``
      : ''

    const taskRes = await fetch(`${url}/rest/v1/task_queue`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        title: `Container update: ${container} (${riskLabel} risk)`,
        description:
          `Apply the **${riskLabel}-risk** image update for \`${container}\`.${versionLine}\n` +
          `Image: \`${image ?? 'unknown'}\`\n\n` +
          `**Steps:**\n` +
          `1. Review the changelog / release notes for breaking changes\n` +
          `2. Update any compose files, config, or env vars if needed\n` +
          `3. Pull new image and restart the container\n` +
          `4. Verify the container is healthy (check logs, health endpoints)\n` +
          `5. Check any services that depend on this container for errors`,
        status: 'ready',
        priority: riskLabel === 'major' ? 1 : 2,
        source: 'dashboard',
        target: 'claude-code',
        tags: ['container-update', `risk:${riskLabel}`, `container:${container}`],
        context: {
          context_summary: `${riskLabel}-risk update for ${container}: ${currentVersion ?? '?'} → ${latestVersion ?? 'latest'}`,
          action_required: 'Apply update and verify no breaking changes',
        },
      }),
    })

    if (!taskRes.ok) {
      const err = await taskRes.text()
      return NextResponse.json({ error: 'Failed to create task', detail: err }, { status: 500 })
    }

    const rows = await taskRes.json()
    const task = Array.isArray(rows) ? rows[0] : rows

    // Mark container as wren_flagged in local state
    const state = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
      : { containers: {}, global_policy: {} }

    state.containers[container] = {
      ...(state.containers[container] ?? {}),
      status: 'wren_flagged',
      flagged_at: new Date().toISOString(),
      task_id: task?.id ?? null,
    }

    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')

    return NextResponse.json({ success: true, taskId: task?.id })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
