/**
 * Microsoft Graph API client for sending mail and reading inbox.
 *
 * Send: MIME passthrough — raw RFC822 message is base64-encoded and POSTed.
 * Read: Fetch messages since last sync, return raw MIME for Gmail import.
 */

import { getAccessToken } from './auth.js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

// ── Send Mail (MIME passthrough) ──────────────────────────────────────────────

/**
 * Send an email via Graph API using raw MIME passthrough.
 * The entire RFC822 message is sent as-is — no parsing/reconstruction needed.
 */
export async function sendMailMime(mimeBuffer: Buffer): Promise<void> {
  const token = await getAccessToken()
  const base64Mime = mimeBuffer.toString('base64')

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: base64Mime,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph sendMail failed (${res.status}): ${text}`)
  }
  // 202 Accepted — mail queued for delivery
}

// ── Read Inbox ────────────────────────────────────────────────────────────────

interface GraphMessage {
  id: string
  receivedDateTime: string
  subject: string
  from: { emailAddress: { address: string; name: string } }
}

interface GraphMessageListResponse {
  value: GraphMessage[]
  '@odata.nextLink'?: string
}

/**
 * Fetch messages received after a given ISO timestamp.
 * Returns message metadata (not full MIME — use fetchMessageMime for that).
 */
export async function fetchNewMessages(sinceIso: string): Promise<GraphMessage[]> {
  const token = await getAccessToken()
  const messages: GraphMessage[] = []

  let url = `${GRAPH_BASE}/me/messages?$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime asc&$top=50&$select=id,receivedDateTime,subject,from`

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Graph messages list failed (${res.status}): ${text}`)
    }

    const data = (await res.json()) as GraphMessageListResponse
    messages.push(...data.value)
    url = data['@odata.nextLink'] ?? ''
  }

  return messages
}

/**
 * Fetch the raw MIME (RFC822) content of a single message.
 * This is what we'll import into Gmail.
 */
export async function fetchMessageMime(messageId: string): Promise<Buffer> {
  const token = await getAccessToken()

  const res = await fetch(`${GRAPH_BASE}/me/messages/${messageId}/$value`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph message MIME fetch failed (${res.status}): ${text}`)
  }

  const arrayBuf = await res.arrayBuffer()
  return Buffer.from(arrayBuf)
}

/**
 * Get the authenticated user's email address.
 */
export async function getMyEmail(): Promise<string> {
  const token = await getAccessToken()

  const res = await fetch(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph /me failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { mail?: string; userPrincipalName?: string }
  return data.mail ?? data.userPrincipalName ?? 'unknown'
}
