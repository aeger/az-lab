import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { sshExec } from '@/lib/ssh-exec'

const STATE_FILE = join(process.cwd(), 'data', 'update_state.json')
const VALID_ACTIONS = ['update_now', 'schedule', 'skip', 'ignore', 'unignore'] as const
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export async function POST(req: NextRequest) {
  // Auth is enforced at Traefik level (lan-allow@file middleware).
  try {
    const { container, action } = await req.json()

    if (!container || typeof container !== 'string' || !NAME_RE.test(container) || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    // Read current state
    const state = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
      : { containers: {}, global_policy: {} }

    const now = new Date().toISOString()
    const entry = state.containers[container] || {}

    if (action === 'update_now') {
      entry.status = 'requested'
      entry.requested_at = now
      state.containers[container] = entry
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')

      // Trigger immediate update via SSH — apply-updates.py handles 'requested' status immediately
      try {
        const output = await sshExec(
          'python3 /home/almty1/dashboard/scripts/apply-updates.py 2>&1',
          300_000
        )
        // Persist completed status so the update badge clears
        entry.status = 'completed'
        entry.completed_at = new Date().toISOString()
        state.containers[container] = entry
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
        return NextResponse.json({ success: true, status: 'completed', output })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        entry.status = 'failed'
        state.containers[container] = entry
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
        return NextResponse.json({ success: false, status: 'failed', error: msg }, { status: 500 })
      }
    } else if (action === 'schedule') {
      // Schedule for next 3:47 AM UTC
      const target = new Date()
      target.setUTCHours(3, 47, 0, 0)
      if (target.getTime() <= Date.now()) {
        target.setUTCDate(target.getUTCDate() + 1)
      }
      entry.status = 'scheduled'
      entry.scheduled_time = target.toISOString()
    } else if (action === 'skip') {
      const days = state.global_policy?.skip_reassess_days || 30
      const reassess = new Date(Date.now() + days * 86400000)
      entry.status = 'skipped'
      entry.skipped_at = now
      entry.skip_reassess_at = reassess.toISOString()
    } else if (action === 'ignore') {
      entry.status = 'ignored'
      entry.ignored_at = now
    } else if (action === 'unignore') {
      entry.status = 'pending_review'
      delete entry.ignored_at
    }

    state.containers[container] = entry
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')

    return NextResponse.json({ success: true, status: entry.status })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
