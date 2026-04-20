/**
 * MSN Inbox → Gmail import sync.
 *
 * Polls the MSN inbox via Graph API for new messages,
 * fetches their raw MIME, and imports into Gmail via the Gmail API.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchNewMessages, fetchMessageMime } from './graph-client.js'

const STATE_PATH = process.env.SYNC_STATE_PATH ?? '/app/data/sync-state.json'
const GMAIL_API = 'https://gmail.googleapis.com'

// ── Gmail Auth ────────────────────────────────────────────────────────────────

let gmailAccessToken: string | null = null
let gmailTokenExpiry = 0

async function getGmailAccessToken(): Promise<string> {
  if (gmailAccessToken && Date.now() < gmailTokenExpiry) return gmailAccessToken

  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN for inbox sync')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail token refresh failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  gmailAccessToken = data.access_token
  gmailTokenExpiry = Date.now() + (data.expires_in - 60) * 1000 // refresh 60s early
  return gmailAccessToken
}

// ── Gmail Import ──────────────────────────────────────────────────────────────

async function importToGmail(mimeBuffer: Buffer): Promise<string> {
  const token = await getGmailAccessToken()

  const res = await fetch(`${GMAIL_API}/upload/gmail/v1/users/me/messages/import?uploadType=media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'message/rfc822',
    },
    body: new Uint8Array(mimeBuffer),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail import failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { id: string }
  return data.id
}

// ── Sync State ────────────────────────────────────────────────────────────────

interface SyncState {
  lastSyncIso: string
  importedIds: string[] // Graph message IDs already imported
}

async function loadState(): Promise<SyncState> {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = await readFile(STATE_PATH, 'utf-8')
      return JSON.parse(raw) as SyncState
    }
  } catch {
    // Corrupt or missing — start fresh
  }

  // Default: sync from 24 hours ago
  return {
    lastSyncIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    importedIds: [],
  }
}

async function saveState(state: SyncState): Promise<void> {
  const dir = dirname(STATE_PATH)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

// ── Main Sync ─────────────────────────────────────────────────────────────────

export async function syncInbox(): Promise<{ imported: number; errors: number }> {
  const state = await loadState()
  let imported = 0
  let errors = 0

  console.log(`[inbox-sync] Fetching messages since ${state.lastSyncIso}`)
  const messages = await fetchNewMessages(state.lastSyncIso)
  console.log(`[inbox-sync] Found ${messages.length} message(s)`)

  // Keep importedIds list manageable — only last 500
  const importedSet = new Set(state.importedIds.slice(-500))

  for (const msg of messages) {
    if (importedSet.has(msg.id)) {
      continue // Already imported
    }

    try {
      const mime = await fetchMessageMime(msg.id)
      const gmailId = await importToGmail(mime)
      console.log(`[inbox-sync] Imported: "${msg.subject}" from ${msg.from.emailAddress.address} → Gmail ${gmailId}`)
      importedSet.add(msg.id)
      imported++
    } catch (err) {
      console.error(`[inbox-sync] Failed to import message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`)
      errors++
    }
  }

  // Update sync timestamp to the newest message (or now if none)
  const newLastSync = messages.length > 0
    ? messages[messages.length - 1].receivedDateTime
    : new Date().toISOString()

  await saveState({
    lastSyncIso: newLastSync,
    importedIds: [...importedSet].slice(-500),
  })

  console.log(`[inbox-sync] Done. Imported: ${imported}, Errors: ${errors}`)
  return { imported, errors }
}

// ── Periodic Runner ───────────────────────────────────────────────────────────

let syncTimer: NodeJS.Timeout | null = null

export function startPeriodicSync(intervalMs: number): void {
  if (syncTimer) return

  console.log(`[inbox-sync] Starting periodic sync every ${intervalMs / 1000}s`)

  // Run once immediately, then on interval
  syncInbox().catch(err => console.error('[inbox-sync] Initial sync failed:', err))

  syncTimer = setInterval(() => {
    syncInbox().catch(err => console.error('[inbox-sync] Periodic sync failed:', err))
  }, intervalMs)
}

export function stopPeriodicSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}
