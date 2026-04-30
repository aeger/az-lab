#!/usr/bin/env node
/**
 * MS SMTP Relay — OAuth2 SMTP relay for Microsoft personal accounts.
 *
 * Accepts SMTP connections with basic auth (for Gmail send-as),
 * relays via Microsoft Graph API /sendMail with OAuth2.
 * Also runs periodic inbox sync (MSN → Gmail import).
 *
 * Required env vars:
 *   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET — Azure app registration
 *   RELAY_USERNAME, RELAY_PASSWORD — SMTP auth creds for Gmail send-as
 *
 * Optional env vars:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN — for inbox sync
 *   SYNC_INTERVAL_MS — inbox sync interval (default: 300000 = 5 min)
 *   SMTP_PORT — SMTP listen port (default: 2587)
 *   HEALTH_PORT — HTTP health check port (default: 3001)
 */

import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server'
import express from 'express'
import { readFileSync } from 'node:fs'
import { sendMailMime, getMyEmail } from './graph-client.js'
import { startPeriodicSync } from './inbox-sync.js'

// ── Config ────────────────────────────────────────────────────────────────────

const SMTP_PORT = parseInt(process.env.SMTP_PORT ?? '2587', 10)
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? '3001', 10)
const RELAY_USER = process.env.RELAY_USERNAME ?? 'relay'
const RELAY_PASS = process.env.RELAY_PASSWORD
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS ?? '300000', 10)

if (!RELAY_PASS) {
  console.error('ERROR: RELAY_PASSWORD env var is required.')
  process.exit(1)
}

if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET) {
  console.error('ERROR: AZURE_CLIENT_ID and AZURE_CLIENT_SECRET are required.')
  process.exit(1)
}

// ── SMTP Server ───────────────────────────────────────────────────────────────

let relayedCount = 0
let errorCount = 0

const smtpServer = new SMTPServer({
  name: 'ms-smtp-relay.az-lab.dev',
  banner: 'AZ-Lab MS SMTP Relay',
  size: 25 * 1024 * 1024, // 25MB max message
  authMethods: ['PLAIN', 'LOGIN'],
  secure: false,        // Start plain, upgrade via STARTTLS
  // Load TLS cert for STARTTLS (self-signed is fine — Gmail accepts it)
  key: (() => { try { return readFileSync('/app/data/smtp-key.pem') } catch { return undefined } })(),
  cert: (() => { try { return readFileSync('/app/data/smtp-cert.pem') } catch { return undefined } })(),

  // Authenticate against static relay credentials
  onAuth(
    auth: SMTPServerAuthentication,
    _session: SMTPServerSession,
    callback: (err: Error | null, response?: { user: string }) => void
  ) {
    if (auth.username === RELAY_USER && auth.password === RELAY_PASS) {
      callback(null, { user: RELAY_USER })
    } else {
      console.warn(`[smtp] Auth rejected: user=${auth.username}`)
      callback(new Error('Invalid credentials'))
    }
  },

  // Receive message and relay via Graph API
  onData(
    stream: NodeJS.ReadableStream,
    _session: SMTPServerSession,
    callback: (err?: Error | null) => void
  ) {
    const chunks: Buffer[] = []

    stream.on('data', (chunk: Buffer) => chunks.push(chunk))

    stream.on('end', async () => {
      const mimeBuffer = Buffer.concat(chunks)
      console.log(`[smtp] Received message (${mimeBuffer.length} bytes), relaying via Graph...`)

      try {
        await sendMailMime(mimeBuffer)
        relayedCount++
        console.log(`[smtp] ✓ Relayed successfully (total: ${relayedCount})`)
        callback()
      } catch (err) {
        errorCount++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[smtp] ✗ Relay failed: ${msg}`)
        callback(new Error(`Relay failed: ${msg}`))
      }
    })

    stream.on('error', (err: Error) => {
      errorCount++
      console.error(`[smtp] Stream error: ${err.message}`)
      callback(err)
    })
  },
})

smtpServer.on('error', (err: Error) => {
  console.error(`[smtp] Server error: ${err.message}`)
})

// ── Health Check HTTP Server ──────────────────────────────────────────────────

const app = express()

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ms-smtp-relay',
    version: '1.0.0',
    smtp_port: SMTP_PORT,
    relayed: relayedCount,
    errors: errorCount,
  })
})

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify Graph API access on startup
  try {
    const email = await getMyEmail()
    console.log(`[relay] Microsoft account: ${email}`)
  } catch (err) {
    console.warn(`[relay] Warning: Could not verify Graph access (run \`npm run auth\` if needed): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Start SMTP server
  smtpServer.listen(SMTP_PORT, '0.0.0.0', () => {
    console.log(`[smtp] Listening on 0.0.0.0:${SMTP_PORT}`)
    console.log(`[smtp] Auth: user=${RELAY_USER}`)
  })

  // Start health check
  app.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[health] http://0.0.0.0:${HEALTH_PORT}/health`)
  })

  // Start inbox sync if Gmail credentials are configured
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
    startPeriodicSync(SYNC_INTERVAL)
  } else {
    console.log('[inbox-sync] Disabled — set GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN to enable')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
