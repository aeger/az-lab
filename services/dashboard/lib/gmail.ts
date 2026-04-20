import fs from 'fs'
import path from 'path'

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1'
const TOKEN_FILE = '/app/data/gmail_refresh_token.txt'

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

let _cachedToken: { token: string; expires: number } | null = null

export function clearTokenCache() {
  _cachedToken = null
}

function getRefreshToken(): string {
  // File-based token takes precedence over env var (written by OAuth callback)
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (token) return token
  } catch {
    // File doesn't exist yet — fall through to env var
  }
  return process.env.GMAIL_REFRESH_TOKEN || ''
}

async function getAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expires) {
    return _cachedToken.token
  }

  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = getRefreshToken()

  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailAuthError('Gmail OAuth credentials not configured')
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
    _cachedToken = null
    throw new GmailAuthError(`Token refresh failed: ${res.status}`)
  }

  const data = await res.json()
  _cachedToken = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  }
  return _cachedToken.token
}

export function saveRefreshToken(token: string) {
  const dir = path.dirname(TOKEN_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(TOKEN_FILE, token, 'utf8')
  _cachedToken = null
}

async function apiGet(path: string, params?: Record<string, string | string[]>) {
  const token = await getAccessToken()
  const url = new URL(`${GMAIL_API}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item)
      } else {
        url.searchParams.set(k, v)
      }
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Public Types ─────────────────────────────────────────────────────────────

export interface GmailMessage {
  id: string
  threadId: string
  from: string
  subject: string
  snippet: string
  date: string
  unread: boolean
  labels: string[]
}

// ── Public Functions ─────────────────────────────────────────────────────────

export function hasClientCredentials(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET)
}

export function isConfigured(): boolean {
  if (!hasClientCredentials()) return false
  if (process.env.GMAIL_REFRESH_TOKEN) return true
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    return !!token
  } catch {
    return false
  }
}

export async function getProfile(): Promise<{ email: string }> {
  const data = await apiGet('/users/me/profile')
  return { email: data.emailAddress }
}

// Gmail tab → label IDs mapping
export const GMAIL_TABS = {
  all:        { label: 'All',        labelIds: ['INBOX'] },
  promotions: { label: 'Promos',     labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] },
  social:     { label: 'Social',     labelIds: ['INBOX', 'CATEGORY_SOCIAL'] },
  updates:    { label: 'Updates',    labelIds: ['INBOX', 'CATEGORY_UPDATES'] },
} as const

export type GmailTab = keyof typeof GMAIL_TABS

export async function listInbox(maxResults = 15, tab: GmailTab = 'all'): Promise<GmailMessage[]> {
  const labelIds = [...GMAIL_TABS[tab].labelIds]
  const data = await apiGet('/users/me/messages', {
    maxResults: String(maxResults),
    labelIds,
  })

  if (!data.messages?.length) return []

  // Batch fetch message details — metadataHeaders must be repeated params
  const messages = await Promise.allSettled(
    data.messages.map((m: { id: string }) =>
      apiGet(`/users/me/messages/${m.id}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
    ),
  )

  return messages
    .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === 'fulfilled')
    .map((r) => {
      const msg = r.value
      const headers = (msg.payload as Record<string, unknown>)?.headers as { name: string; value: string }[] || []
      const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
      const labelIds = (msg.labelIds || []) as string[]

      return {
        id: msg.id as string,
        threadId: msg.threadId as string,
        from: getHeader('From'),
        subject: getHeader('Subject') || '(No subject)',
        snippet: msg.snippet as string || '',
        date: getHeader('Date'),
        unread: labelIds.includes('UNREAD'),
        labels: labelIds,
      }
    })
}
