#!/usr/bin/env node
/**
 * Gmail MCP Server
 *
 * Full-featured Gmail management via the Model Context Protocol.
 * Supports reading, searching, trashing, deleting, archiving, labeling,
 * and batch operations on Gmail messages.
 *
 * Required environment variables:
 *   GMAIL_CLIENT_ID      - OAuth2 client ID from Google Cloud Console
 *   GMAIL_CLIENT_SECRET  - OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN  - Refresh token from one-time auth-setup flow
 *
 * Run `npm run auth` to generate your GMAIL_REFRESH_TOKEN.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { OAuth2Client } from 'google-auth-library'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'
import express from 'express'

// ── Constants ──────────────────────────────────────────────────────────────────

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CHARACTER_LIMIT = 25_000

// Send allowlist — comma-separated task IDs permitted to send without manual review.
// Set GMAIL_SEND_ALLOWLIST env var to override. Default: daily-email-triage.
function getSendAllowlist(): Set<string> {
  const raw = process.env.GMAIL_SEND_ALLOWLIST ?? 'daily-email-triage'
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

function isAllowedToSend(authorizedBy?: string): boolean {
  if (!authorizedBy) return false
  return getSendAllowlist().has(authorizedBy.trim())
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface GmailMessageHeader {
  name: string
  value: string
}

interface GmailPayload {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailPayload[]
  headers?: GmailMessageHeader[]
}

interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  sizeEstimate?: number
  internalDate?: string
  payload?: GmailPayload
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

interface GmailLabel {
  id: string
  name: string
  type?: string
}

interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
}

interface GmailSendAs {
  sendAsEmail: string
  displayName: string
  replyToAddress?: string
  signature?: string
  isPrimary?: boolean
  isDefault?: boolean
  verificationStatus?: string
}

interface MessageSummary {
  id: string
  subject: string
  from: string
  date: string
  snippet: string
  labels: string[]
}

// ── OAuth2 Auth ────────────────────────────────────────────────────────────────

let _oauthClient: OAuth2Client | null = null

function getOAuthClient(): OAuth2Client {
  if (_oauthClient) return _oauthClient

  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing required environment variables: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN\n' +
        'Run `npm run auth` in the gmail-mcp-server directory to generate your refresh token.'
    )
  }

  _oauthClient = new OAuth2Client(clientId, clientSecret)
  _oauthClient.setCredentials({ refresh_token: refreshToken })
  return _oauthClient
}

async function getAccessToken(): Promise<string> {
  const client = getOAuthClient()
  const response = await client.getAccessToken()
  if (!response.token) throw new Error('Failed to obtain Gmail access token')
  return response.token
}

// ── R2 (Cloudflare) Client ────────────────────────────────────────────────────

function getR2Client(): S3Client | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
}

const R2_BUCKET = process.env.R2_BUCKET_NAME ?? 'az-lab-cdn'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? '' // e.g. https://cdn.az-lab.dev

// ── Shared API Utilities ───────────────────────────────────────────────────────

async function gmailRequest(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH' = 'GET',
  body?: unknown,
  params?: Record<string, string>
): Promise<unknown> {
  const token = await getAccessToken()
  const urlObj = new URL(`${GMAIL_API}${path}`)

  if (params) {
    for (const [k, v] of Object.entries(params)) urlObj.searchParams.set(k, v)
  }

  const res = await fetch(urlObj.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 204) return {}

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gmail API ${res.status}: ${text}`)
  }

  return res.json() as Promise<unknown>
}

function handleError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message
    if (msg.includes('401')) return `Error: Authentication failed — check your OAuth credentials. Run \`npm run auth\` to refresh. Details: ${msg}`
    if (msg.includes('403')) return `Error: Permission denied. Your token may lack the required Gmail scope. Run \`npm run auth\` to re-authorize. Details: ${msg}`
    if (msg.includes('429')) return 'Error: Gmail rate limit exceeded. Please wait a moment and try again.'
    if (msg.includes('404')) return 'Error: Message not found — it may have already been deleted or trashed.'
    return `Error: ${msg}`
  }
  return `Error: ${String(error)}`
}

// ── Body Decoding ──────────────────────────────────────────────────────────────

function decodeBase64Url(encoded: string): string {
  try {
    return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  } catch {
    return '[Could not decode content]'
  }
}

function extractBody(payload: GmailPayload): string {
  if (payload.body?.data) return decodeBase64Url(payload.body.data)

  if (payload.parts) {
    const text = payload.parts.find(p => p.mimeType === 'text/plain')
    const html = payload.parts.find(p => p.mimeType === 'text/html')
    const chosen = text ?? html
    if (chosen?.body?.data) return decodeBase64Url(chosen.body.data)

    for (const part of payload.parts) {
      const nested = extractBody(part)
      if (nested) return nested
    }
  }

  return ''
}

// ── Message Formatting ─────────────────────────────────────────────────────────

function getHeader(headers: GmailMessageHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function formatMessageFull(msg: GmailMessage): string {
  const headers = msg.payload?.headers
  const lines = [
    `**ID**: ${msg.id}`,
    `**Subject**: ${getHeader(headers, 'Subject') || '(no subject)'}`,
    `**From**: ${getHeader(headers, 'From')}`,
    `**To**: ${getHeader(headers, 'To')}`,
    `**Date**: ${getHeader(headers, 'Date')}`,
    `**Labels**: ${(msg.labelIds ?? []).join(', ')}`,
    `**Snippet**: ${msg.snippet ?? ''}`,
  ]

  if (msg.payload) {
    const body = extractBody(msg.payload)
    if (body) {
      lines.push('', '---', '**Body**:', body.slice(0, 4000))
      if (body.length > 4000) lines.push('\n... [body truncated]')
    }
  }

  return lines.join('\n')
}

async function fetchMessageSummary(id: string): Promise<MessageSummary> {
  const msg = (await gmailRequest(`/messages/${id}`, 'GET', undefined, {
    format: 'metadata',
    metadataHeaders: 'Subject,From,To,Date',
  })) as GmailMessage

  const headers = msg.payload?.headers
  return {
    id: msg.id,
    subject: getHeader(headers, 'Subject') || '(no subject)',
    from: getHeader(headers, 'From'),
    date: getHeader(headers, 'Date'),
    snippet: msg.snippet ?? '',
    labels: msg.labelIds ?? [],
  }
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'gmail-mcp-server', version: '1.0.0' })

// ── gmail_get_profile ──────────────────────────────────────────────────────────

server.registerTool(
  'gmail_get_profile',
  {
    title: 'Get Gmail Profile',
    description: 'Returns the authenticated Gmail account email address, total message count, and thread count.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const p = (await gmailRequest('/profile')) as GmailProfile
      return { content: [{ type: 'text' as const, text: `**Gmail**: ${p.emailAddress}\n**Messages**: ${p.messagesTotal.toLocaleString()}\n**Threads**: ${p.threadsTotal.toLocaleString()}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_search_messages ──────────────────────────────────────────────────────

server.registerTool(
  'gmail_search_messages',
  {
    title: 'Search Gmail Messages',
    description: `Search Gmail using Gmail's full search syntax. Returns IDs, subjects, senders, dates, snippets.

Query examples:
  "in:inbox newer_than:30d"            — inbox last 30 days
  "from:boss@company.com is:unread"    — unread from boss
  "category:promotions newer_than:30d" — recent promos
  "subject:invoice has:attachment"     — invoices with attachments
  "in:spam OR in:trash newer_than:7d"  — recent spam/trash

Returns: { messages: [{id, subject, from, date, snippet, labels}], total_estimate, has_more, next_page_token }`,
    inputSchema: z.object({
      query: z.string().min(1).describe("Gmail search query (e.g., 'in:inbox is:unread newer_than:7d')"),
      max_results: z.number().int().min(1).max(500).default(20).describe('Max messages to return (1–500, default 20)'),
      page_token: z.string().optional().describe('Pagination token from previous search'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ query, max_results, page_token }) => {
    try {
      const p: Record<string, string> = { q: query, maxResults: String(max_results) }
      if (page_token) p.pageToken = page_token

      const data = (await gmailRequest('/messages', 'GET', undefined, p)) as GmailMessageListResponse
      if (!data.messages?.length) return { content: [{ type: 'text' as const, text: `No messages found matching: "${query}"` }] }

      const settled = await Promise.allSettled(data.messages.map(m => fetchMessageSummary(m.id)))
      const messages = settled.filter((r): r is PromiseFulfilledResult<MessageSummary> => r.status === 'fulfilled').map(r => r.value)

      const result = { messages, total_estimate: data.resultSizeEstimate ?? messages.length, has_more: !!data.nextPageToken, next_page_token: data.nextPageToken ?? null }
      let text = JSON.stringify(result, null, 2)
      if (text.length > CHARACTER_LIMIT) text = JSON.stringify({ ...result, messages: messages.slice(0, 10), note: 'Truncated — refine query or reduce max_results.' }, null, 2)

      return { content: [{ type: 'text' as const, text }], structuredContent: result }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_read_message ─────────────────────────────────────────────────────────

server.registerTool(
  'gmail_read_message',
  {
    title: 'Read Full Gmail Message',
    description: 'Read the full content of a Gmail message including headers and decoded body. Use gmail_search_messages first to get message IDs.',
    inputSchema: z.object({
      message_id: z.string().min(1).describe('Gmail message ID to read'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_id }) => {
    try {
      const msg = (await gmailRequest(`/messages/${message_id}`, 'GET', undefined, { format: 'full' })) as GmailMessage
      return { content: [{ type: 'text' as const, text: formatMessageFull(msg) }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_trash_message ────────────────────────────────────────────────────────

server.registerTool(
  'gmail_trash_message',
  {
    title: 'Trash Gmail Message',
    description: 'Move a single Gmail message to Trash (recoverable for 30 days). For bulk cleanup use gmail_batch_trash.',
    inputSchema: z.object({ message_id: z.string().min(1).describe('Message ID to trash') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_id }) => {
    try {
      await gmailRequest(`/messages/${message_id}/trash`, 'POST')
      return { content: [{ type: 'text' as const, text: `✓ Message ${message_id} moved to Trash.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_delete_message ───────────────────────────────────────────────────────

server.registerTool(
  'gmail_delete_message',
  {
    title: 'Permanently Delete Gmail Message',
    description: 'PERMANENTLY delete a single Gmail message. Cannot be undone. For recoverable deletion use gmail_trash_message. For bulk use gmail_batch_delete.',
    inputSchema: z.object({ message_id: z.string().min(1).describe('Message ID to permanently delete') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_id }) => {
    try {
      await gmailRequest(`/messages/${message_id}`, 'DELETE')
      return { content: [{ type: 'text' as const, text: `✓ Message ${message_id} permanently deleted.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_batch_trash ──────────────────────────────────────────────────────────

server.registerTool(
  'gmail_batch_trash',
  {
    title: 'Batch Trash Gmail Messages',
    description: `Move multiple Gmail messages to Trash in one operation. Messages are recoverable for 30 days.

Primary tool for bulk cleanup: use gmail_search_messages to get IDs, then pass them all here.
For permanent deletion use gmail_batch_delete.`,
    inputSchema: z.object({
      message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Array of message IDs to trash (max 1000)'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids }) => {
    try {
      await gmailRequest('/messages/batchModify', 'POST', { ids: message_ids, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] })
      const preview = message_ids.slice(0, 5).join(', ') + (message_ids.length > 5 ? ` … +${message_ids.length - 5} more` : '')
      return { content: [{ type: 'text' as const, text: `✓ ${message_ids.length} message(s) moved to Trash.\nIDs: ${preview}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_batch_delete ─────────────────────────────────────────────────────────

server.registerTool(
  'gmail_batch_delete',
  {
    title: 'Batch Permanently Delete Gmail Messages',
    description: 'PERMANENTLY delete multiple Gmail messages. Cannot be undone. For recoverable deletion use gmail_batch_trash.',
    inputSchema: z.object({
      message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Array of message IDs to permanently delete (max 1000)'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids }) => {
    try {
      await gmailRequest('/messages/batchDelete', 'POST', { ids: message_ids })
      return { content: [{ type: 'text' as const, text: `✓ ${message_ids.length} message(s) permanently deleted.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_archive_message ──────────────────────────────────────────────────────

server.registerTool(
  'gmail_archive_message',
  {
    title: 'Archive Gmail Message',
    description: 'Archive a single message (remove from Inbox, keep in All Mail). For bulk use gmail_batch_archive.',
    inputSchema: z.object({ message_id: z.string().min(1).describe('Message ID to archive') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_id }) => {
    try {
      await gmailRequest(`/messages/${message_id}/modify`, 'POST', { removeLabelIds: ['INBOX'] })
      return { content: [{ type: 'text' as const, text: `✓ Message ${message_id} archived.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_batch_archive ────────────────────────────────────────────────────────

server.registerTool(
  'gmail_batch_archive',
  {
    title: 'Batch Archive Gmail Messages',
    description: 'Archive multiple messages at once (remove from Inbox, keep in All Mail, fully searchable).',
    inputSchema: z.object({
      message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Array of message IDs to archive (max 1000)'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids }) => {
    try {
      await gmailRequest('/messages/batchModify', 'POST', { ids: message_ids, removeLabelIds: ['INBOX'] })
      return { content: [{ type: 'text' as const, text: `✓ ${message_ids.length} message(s) archived.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_mark_read ────────────────────────────────────────────────────────────

server.registerTool(
  'gmail_mark_read',
  {
    title: 'Mark Gmail Messages as Read',
    description: 'Mark one or more messages as read (removes UNREAD label).',
    inputSchema: z.object({ message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Message IDs to mark as read') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids }) => {
    try {
      await gmailRequest('/messages/batchModify', 'POST', { ids: message_ids, removeLabelIds: ['UNREAD'] })
      return { content: [{ type: 'text' as const, text: `✓ ${message_ids.length} message(s) marked as read.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_mark_unread ──────────────────────────────────────────────────────────

server.registerTool(
  'gmail_mark_unread',
  {
    title: 'Mark Gmail Messages as Unread',
    description: 'Mark one or more messages as unread (adds UNREAD label).',
    inputSchema: z.object({ message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Message IDs to mark as unread') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids }) => {
    try {
      await gmailRequest('/messages/batchModify', 'POST', { ids: message_ids, addLabelIds: ['UNREAD'] })
      return { content: [{ type: 'text' as const, text: `✓ ${message_ids.length} message(s) marked as unread.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_list_labels ──────────────────────────────────────────────────────────

server.registerTool(
  'gmail_list_labels',
  {
    title: 'List Gmail Labels',
    description: 'List all Gmail labels (system labels like INBOX, SPAM, TRASH and user-created labels). Returns IDs needed for gmail_apply_label.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const data = (await gmailRequest('/labels')) as { labels: GmailLabel[] }
      const labels = data.labels ?? []
      const system = labels.filter(l => l.type === 'system')
      const user = labels.filter(l => l.type !== 'system')
      const lines = ['## System Labels', ...system.map(l => `- **${l.name}** (\`${l.id}\`)`), '', '## User Labels', ...(user.length ? user.map(l => `- **${l.name}** (\`${l.id}\`)`) : ['(none)'])]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_apply_label ──────────────────────────────────────────────────────────

server.registerTool(
  'gmail_apply_label',
  {
    title: 'Apply or Remove Labels on Gmail Messages',
    description: `Add or remove labels on one or more messages. Use gmail_list_labels to find label IDs.

Common IDs: INBOX, TRASH, SPAM, UNREAD, STARRED, IMPORTANT`,
    inputSchema: z.object({
      message_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Message IDs to modify'),
      add_label_ids: z.array(z.string()).optional().describe("Label IDs to add (e.g., ['STARRED'])"),
      remove_label_ids: z.array(z.string()).optional().describe("Label IDs to remove (e.g., ['INBOX'])"),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ message_ids, add_label_ids, remove_label_ids }) => {
    try {
      if (!add_label_ids?.length && !remove_label_ids?.length) return { content: [{ type: 'text' as const, text: 'Error: Provide at least one of add_label_ids or remove_label_ids.' }] }
      await gmailRequest('/messages/batchModify', 'POST', { ids: message_ids, ...(add_label_ids?.length ? { addLabelIds: add_label_ids } : {}), ...(remove_label_ids?.length ? { removeLabelIds: remove_label_ids } : {}) })
      const parts = [...(add_label_ids?.length ? [`added [${add_label_ids.join(', ')}]`] : []), ...(remove_label_ids?.length ? [`removed [${remove_label_ids.join(', ')}]`] : [])]
      return { content: [{ type: 'text' as const, text: `✓ Labels updated on ${message_ids.length} message(s): ${parts.join(', ')}.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_create_draft ────────────────────────────────────────────────────────

server.registerTool(
  'gmail_create_draft',
  {
    title: 'Create Gmail Draft',
    description: 'Create a draft email (not sent). Returns the draft ID for later use with gmail_send_draft.',
    inputSchema: z.object({
      to: z.string().min(1).describe('Recipient email address(es), comma-separated'),
      subject: z.string().min(1).describe('Email subject'),
      body: z.string().min(1).describe('Plain-text email body'),
      cc: z.string().optional().describe('CC recipients, comma-separated'),
      bcc: z.string().optional().describe('BCC recipients, comma-separated'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ to, subject, body, cc, bcc }) => {
    try {
      const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        'Content-Type: text/plain; charset=utf-8',
      ]
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`).toString('base64url')
      const draft = (await gmailRequest('/drafts', 'POST', { message: { raw } })) as { id: string; message: { id: string } }
      return { content: [{ type: 'text' as const, text: `✓ Draft created.\n**Draft ID**: ${draft.id}\n**Message ID**: ${draft.message.id}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_send ───────────────────────────────────────────────────────────────

const GMAIL_SEND_ALLOWLIST = (process.env.GMAIL_SEND_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean)

server.registerTool(
  'gmail_send',
  {
    title: 'Send Gmail Message',
    description: `Compose and send an email directly.

Requires authorized_by to match a task ID on the send allowlist (set via GMAIL_SEND_ALLOWLIST env var).
If not on the allowlist, a draft is created instead and the caller is notified.

Pre-approved: ${GMAIL_SEND_ALLOWLIST.join(', ') || '(none)'}`,
    inputSchema: z.object({
      to: z.string().min(1).describe('Recipient email address(es), comma-separated'),
      subject: z.string().min(1).describe('Email subject'),
      body: z.string().min(1).describe('Plain-text email body'),
      cc: z.string().optional().describe('CC recipients, comma-separated'),
      bcc: z.string().optional().describe('BCC recipients, comma-separated'),
      authorized_by: z.string().optional().describe('Task/sender ID requesting to send. Must match an entry in the send allowlist.'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ to, subject, body, cc, bcc, authorized_by }) => {
    try {
      const headers = [
        `To: ${to}`,
        `Subject: ${subject}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        'Content-Type: text/plain; charset=utf-8',
      ]
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`).toString('base64url')

      if (!authorized_by || !GMAIL_SEND_ALLOWLIST.includes(authorized_by)) {
        const draft = (await gmailRequest('/drafts', 'POST', { message: { raw } })) as { id: string; message: { id: string } }
        return { content: [{ type: 'text' as const, text: `⚠ Not authorized to send (authorized_by: "${authorized_by ?? ''}").\nDraft created instead.\n**Draft ID**: ${draft.id}` }] }
      }

      const sent = (await gmailRequest('/messages/send', 'POST', { raw })) as { id: string; threadId: string }
      return { content: [{ type: 'text' as const, text: `✓ Email sent.\n**Message ID**: ${sent.id}\n**Thread ID**: ${sent.threadId}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_send_draft ─────────────────────────────────────────────────────────

server.registerTool(
  'gmail_send_draft',
  {
    title: 'Send Gmail Draft',
    description: `Send a previously created draft by its draft ID.

Requires authorized_by to match a task ID on the send allowlist (set via GMAIL_SEND_ALLOWLIST env var).
If not on the allowlist, the draft is left unsent and the caller is notified.

Pre-approved: ${GMAIL_SEND_ALLOWLIST.join(', ') || '(none)'}`,
    inputSchema: z.object({
      draft_id: z.string().min(1).describe('Draft ID (from gmail_create_draft or Gmail API)'),
      authorized_by: z.string().optional().describe('Task/sender ID requesting to send. Must match an entry in the send allowlist.'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ draft_id, authorized_by }) => {
    try {
      if (!authorized_by || !GMAIL_SEND_ALLOWLIST.includes(authorized_by)) {
        return { content: [{ type: 'text' as const, text: `⚠ Not authorized to send (authorized_by: "${authorized_by ?? ''}").\nDraft ${draft_id} left unsent.` }] }
      }
      const sent = (await gmailRequest('/drafts/send', 'POST', { id: draft_id })) as { id: string; threadId: string }
      return { content: [{ type: 'text' as const, text: `✓ Draft sent.\n**Message ID**: ${sent.id}\n**Thread ID**: ${sent.threadId}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_create_label ───────────────────────────────────────────────────────

server.registerTool(
  'gmail_create_label',
  {
    title: 'Create Gmail Label',
    description: 'Create a new user-defined Gmail label. Returns the new label ID.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Label name (e.g., "Work/Invoices")'),
      background_color: z.string().optional().describe('Background color hex (e.g., "#e2d0f8")'),
      text_color: z.string().optional().describe('Text color hex (e.g., "#000000")'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ name, background_color, text_color }) => {
    try {
      const body: Record<string, unknown> = { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
      if (background_color || text_color) {
        body.color = { ...(background_color ? { backgroundColor: background_color } : {}), ...(text_color ? { textColor: text_color } : {}) }
      }
      const label = (await gmailRequest('/labels', 'POST', body)) as GmailLabel
      return { content: [{ type: 'text' as const, text: `✓ Label created.\n**Name**: ${label.name}\n**ID**: ${label.id}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_delete_label ───────────────────────────────────────────────────────

server.registerTool(
  'gmail_delete_label',
  {
    title: 'Delete Gmail Label',
    description: 'Delete a user-defined Gmail label. Cannot delete system labels (INBOX, SENT, etc.). Messages keep their other labels.',
    inputSchema: z.object({
      label_id: z.string().min(1).describe('Label ID to delete (use gmail_list_labels to find IDs)'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ label_id }) => {
    try {
      await gmailRequest(`/labels/${label_id}`, 'DELETE')
      return { content: [{ type: 'text' as const, text: `✓ Label ${label_id} deleted.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_update_label ───────────────────────────────────────────────────────

server.registerTool(
  'gmail_update_label',
  {
    title: 'Update Gmail Label',
    description: 'Rename or change the color of an existing user-defined Gmail label.',
    inputSchema: z.object({
      label_id: z.string().min(1).describe('Label ID to update (use gmail_list_labels to find IDs)'),
      name: z.string().optional().describe('New label name'),
      background_color: z.string().optional().describe('New background color hex (e.g., "#e2d0f8")'),
      text_color: z.string().optional().describe('New text color hex (e.g., "#000000")'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ label_id, name, background_color, text_color }) => {
    try {
      const body: Record<string, unknown> = {}
      if (name) body.name = name
      if (background_color || text_color) {
        body.color = { ...(background_color ? { backgroundColor: background_color } : {}), ...(text_color ? { textColor: text_color } : {}) }
      }
      const label = (await gmailRequest(`/labels/${label_id}`, 'PATCH', body)) as GmailLabel
      return { content: [{ type: 'text' as const, text: `✓ Label updated.\n**Name**: ${label.name}\n**ID**: ${label.id}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_list_send_as ───────────────────────────────────────────────────────

server.registerTool(
  'gmail_list_send_as',
  {
    title: 'List Gmail Send-As Aliases',
    description: 'List all send-as email aliases configured on your Gmail account, including their display names, signatures, and verification status. Use this to find which email address to target when updating a signature.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const data = (await gmailRequest('/settings/sendAs')) as { sendAs: GmailSendAs[] }
      const aliases = data.sendAs ?? []
      const lines = aliases.map(a => {
        const flags = [a.isPrimary ? 'PRIMARY' : null, a.isDefault ? 'DEFAULT' : null, a.verificationStatus].filter(Boolean).join(', ')
        return `- **${a.displayName || '(no name)'}** <${a.sendAsEmail}> [${flags}]\n  Signature: ${a.signature ? `${a.signature.length} chars HTML` : '(empty)'}`
      })
      return { content: [{ type: 'text' as const, text: `## Send-As Aliases\n\n${lines.join('\n\n')}` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_create_send_as ─────────────────────────────────────────────────────

server.registerTool(
  'gmail_create_send_as',
  {
    title: 'Create Gmail Send-As Alias',
    description: `Add a new send-as email alias with optional external SMTP configuration.

Use this to add external email accounts (Outlook, MSN, Yahoo, custom domain, etc.) so Gmail can send mail as that address. Gmail validates the SMTP connection on create.

A verification email is sent to the alias address — the owner must click the link before it becomes usable.

Common SMTP configs:
- Outlook/MSN/Hotmail: host=smtp-mail.outlook.com, port=587, security=starttls
- Yahoo: host=smtp.mail.yahoo.com, port=587, security=starttls
- Custom domain: your mail server's SMTP details

Note: For Microsoft accounts, enable 2FA first, then create an app password at account.microsoft.com/security.`,
    inputSchema: z.object({
      email: z.string().email().describe('The email address to add as a send-as alias'),
      display_name: z.string().optional().describe('Display name for this alias (e.g., "Jeff Cook")'),
      reply_to: z.string().email().optional().describe('Reply-to address (defaults to the alias email)'),
      smtp_host: z.string().optional().describe('External SMTP server hostname (e.g., smtp-mail.outlook.com)'),
      smtp_port: z.number().int().optional().describe('SMTP port (e.g., 587 for STARTTLS, 465 for SSL)'),
      smtp_username: z.string().optional().describe('SMTP username (usually the email address)'),
      smtp_password: z.string().optional().describe('SMTP password or app password'),
      smtp_security: z.enum(['none', 'ssl', 'starttls']).optional().describe('SMTP security mode (default: starttls)'),
      treat_as_alias: z.boolean().optional().describe('If true, Gmail treats replies to this address the same as the primary. Default: true'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ email, display_name, reply_to, smtp_host, smtp_port, smtp_username, smtp_password, smtp_security, treat_as_alias }) => {
    try {
      const body: Record<string, unknown> = {
        sendAsEmail: email,
        displayName: display_name ?? '',
        treatAsAlias: treat_as_alias ?? true,
      }
      if (reply_to) body.replyToAddress = reply_to

      if (smtp_host) {
        body.smtpMsa = {
          host: smtp_host,
          port: smtp_port ?? 587,
          username: smtp_username ?? email,
          password: smtp_password ?? '',
          securityMode: smtp_security ?? 'starttls',
        }
      }

      const created = (await gmailRequest('/settings/sendAs', 'POST', body)) as GmailSendAs
      const lines = [
        `✓ Send-As alias created.`,
        `**Email**: ${created.sendAsEmail}`,
        `**Display Name**: ${created.displayName || '(not set)'}`,
        `**Verification**: ${created.verificationStatus ?? 'pending'}`,
        '',
        created.verificationStatus === 'accepted'
          ? 'Alias is verified and ready to use.'
          : '⚠ A verification email has been sent to this address. The owner must click the link to activate.',
      ]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_delete_send_as ─────────────────────────────────────────────────────

server.registerTool(
  'gmail_delete_send_as',
  {
    title: 'Delete Gmail Send-As Alias',
    description: 'Remove a send-as alias from your Gmail account. Cannot delete the primary send-as address.',
    inputSchema: z.object({
      email: z.string().email().describe('The send-as email address to remove'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ email }) => {
    try {
      await gmailRequest(`/settings/sendAs/${encodeURIComponent(email)}`, 'DELETE')
      return { content: [{ type: 'text' as const, text: `✓ Send-As alias ${email} removed.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_verify_send_as ─────────────────────────────────────────────────────

server.registerTool(
  'gmail_verify_send_as',
  {
    title: 'Resend Send-As Verification Email',
    description: 'Resend the verification email for a pending send-as alias. The alias owner must click the verification link before the alias becomes usable.',
    inputSchema: z.object({
      email: z.string().email().describe('The send-as email address to resend verification for'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ email }) => {
    try {
      await gmailRequest(`/settings/sendAs/${encodeURIComponent(email)}/verify`, 'POST')
      return { content: [{ type: 'text' as const, text: `✓ Verification email resent to ${email}. Check that inbox and click the link.` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_get_signature ──────────────────────────────────────────────────────

server.registerTool(
  'gmail_get_signature',
  {
    title: 'Get Gmail Signature',
    description: 'Get the current email signature for a send-as address. Returns the raw HTML signature content.',
    inputSchema: z.object({
      email: z.string().email().describe('The send-as email address to get the signature for (use gmail_list_send_as to find addresses)'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ email }) => {
    try {
      const sendAs = (await gmailRequest(`/settings/sendAs/${encodeURIComponent(email)}`)) as GmailSendAs
      const sig = sendAs.signature || ''
      const lines = [
        `**Email**: ${sendAs.sendAsEmail}`,
        `**Display Name**: ${sendAs.displayName || '(not set)'}`,
        `**Reply-To**: ${sendAs.replyToAddress || '(same as send-as)'}`,
        '',
        '**Signature HTML**:',
        '```html',
        sig || '(empty — no signature set)',
        '```',
      ]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_update_signature ───────────────────────────────────────────────────

server.registerTool(
  'gmail_update_signature',
  {
    title: 'Update Gmail Signature',
    description: `Update the email signature for a send-as address. The signature must be valid HTML.

Tips:
- Use <img src="https://..."> for images (must be publicly accessible URLs)
- Use <a href="..."> for links
- Use <br> for line breaks, <b>/<i> for bold/italic
- Gmail strips unsafe tags — stick to basic HTML formatting
- Set signature to empty string "" to remove the signature
- Optionally update display name and reply-to address at the same time`,
    inputSchema: z.object({
      email: z.string().email().describe('The send-as email address to update'),
      signature: z.string().describe('HTML signature content (empty string to clear)'),
      display_name: z.string().optional().describe('Optionally update the display name'),
      reply_to: z.string().optional().describe('Optionally update the reply-to address'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ email, signature, display_name, reply_to }) => {
    try {
      const body: Record<string, unknown> = { signature }
      if (display_name !== undefined) body.displayName = display_name
      if (reply_to !== undefined) body.replyToAddress = reply_to

      const updated = (await gmailRequest(`/settings/sendAs/${encodeURIComponent(email)}`, 'PATCH', body)) as GmailSendAs
      const lines = [
        `✓ Signature updated for ${updated.sendAsEmail}`,
        `**Display Name**: ${updated.displayName || '(not set)'}`,
        `**Signature**: ${updated.signature ? `${updated.signature.length} chars HTML` : '(cleared)'}`,
      ]
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── gmail_upload_signature_image ──────────────────────────────────────────────

server.registerTool(
  'gmail_upload_signature_image',
  {
    title: 'Upload Signature Image to R2',
    description: `Upload an image to Cloudflare R2 for use in Gmail signatures. Returns a public URL that can be embedded in signature HTML via <img src="...">.

Requires R2 environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL.
Images are stored in the "signatures/" prefix of the configured R2 bucket.

Supported formats: PNG, JPEG, GIF, SVG, WebP.`,
    inputSchema: z.object({
      image_data: z.string().min(1).describe('Base64-encoded image data (without the data:image/... prefix)'),
      filename: z.string().min(1).describe('Filename for the image (e.g., "logo.png", "headshot.jpg")'),
      content_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp']).describe('MIME type of the image'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ image_data, filename, content_type }) => {
    try {
      const r2 = getR2Client()
      if (!r2) {
        return { content: [{ type: 'text' as const, text: 'Error: R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.' }] }
      }
      if (!R2_PUBLIC_URL) {
        return { content: [{ type: 'text' as const, text: 'Error: R2_PUBLIC_URL not set. Configure the public URL for your R2 bucket (e.g., https://cdn.az-lab.dev).' }] }
      }

      const key = `signatures/${filename}`
      const body = Buffer.from(image_data, 'base64')

      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: content_type,
        CacheControl: 'public, max-age=31536000',
      }))

      const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
      return { content: [{ type: 'text' as const, text: `✓ Image uploaded to R2.\n**URL**: ${publicUrl}\n**Size**: ${body.length.toLocaleString()} bytes\n**Type**: ${content_type}\n\nUse in signature HTML:\n\`\`\`html\n<img src="${publicUrl}" alt="${filename}" />\n\`\`\`` }] }
    } catch (e) { return { content: [{ type: 'text' as const, text: handleError(e) }] } }
  }
)

// ── HTTP Server ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    console.error('ERROR: Missing required environment variables:\n  GMAIL_CLIENT_ID\n  GMAIL_CLIENT_SECRET\n  GMAIL_REFRESH_TOKEN')
    process.exit(1)
  }

  const app = express()
  app.use(express.json())

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'gmail-mcp-server', version: '1.2.0' })
  })

  // MCP endpoint — new transport per request (stateless)
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  const port = parseInt(process.env.PORT ?? '3000', 10)
  app.listen(port, '0.0.0.0', () => {
    console.log(`Gmail MCP Server running — http://0.0.0.0:${port}/mcp (26 tools)`)
    console.log(`Send allowlist: ${[...getSendAllowlist()].join(', ') || '(empty)'}`)
    console.log(`Health check — http://0.0.0.0:${port}/health`)
  })

  // Heartbeat reporter — upserts to agent_heartbeat every 60s
  const SUPABASE_URL = 'https://ogqjjlbupqnvlcyrfnxi.supabase.co'
  const SUPABASE_KEY = process.env.SUPABASE_KEY ?? ''
  if (SUPABASE_KEY) {
    const sendHeartbeat = async () => {
      let gmailAuthExpired = false
      try {
        await getOAuthClient().getAccessToken()
      } catch {
        gmailAuthExpired = true
      }
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/agent_heartbeat?on_conflict=agent`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            agent: 'gmail_mcp',
            status: gmailAuthExpired ? 'auth_expired' : 'healthy',
            last_heartbeat: new Date().toISOString(),
            metadata: { gmail_auth_expired: gmailAuthExpired, port },
          }),
        })
      } catch { /* best-effort */ }
    }
    sendHeartbeat()
    setInterval(sendHeartbeat, 60_000)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
