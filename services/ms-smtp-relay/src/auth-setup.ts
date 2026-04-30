#!/usr/bin/env node
/**
 * One-time Microsoft OAuth2 setup.
 *
 * Usage:
 *   1. Ensure .env has AZURE_CLIENT_ID and AZURE_CLIENT_SECRET
 *   2. Run: npm run auth
 *   3. Sign in with your Microsoft account (almty1@msn.com)
 *   4. Token cache is saved to data/token-cache.json
 */

import { ConfidentialClientApplication } from '@azure/msal-node'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as http from 'node:http'
import * as url from 'node:url'
import * as path from 'node:path'

// Load .env file if present
async function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  const content = await readFile(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}
await loadEnv()

const PORT = 3000
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
const SCOPES = ['Mail.Send', 'Mail.Read', 'offline_access', 'User.Read']
const CACHE_PATH = process.env.TOKEN_CACHE_PATH ?? './data/token-cache.json'
const TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

async function main() {
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const tenantId = process.env.AZURE_TENANT_ID ?? 'consumers'

  if (!clientId || !clientSecret) {
    console.error(
      'ERROR: Set AZURE_CLIENT_ID and AZURE_CLIENT_SECRET first.\n' +
        '  In .env or as environment variables.'
    )
    process.exit(1)
  }

  const msalApp = new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  })

  const authUrl = await msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    prompt: 'consent',
  })

  console.log('\n=== MS SMTP Relay — OAuth Setup ===\n')
  console.log('Opening your browser for Microsoft authorization...')
  console.log('\nIf it does not open automatically, paste this URL:\n')
  console.log(authUrl)
  console.log('\n⏳ Waiting for authorization (15 min timeout)...\n')
  console.log('>>> CLICK ACCEPT on the Microsoft consent page <<<\n')

  // Open browser
  const { exec } = await import('node:child_process')
  const platform = process.platform
  const openCmd =
    platform === 'win32' ? `start "" "${authUrl}"` :
    platform === 'darwin' ? `open "${authUrl}"` :
    `xdg-open "${authUrl}"`
  exec(openCmd)

  // Listen for callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return
      const parsed = url.parse(req.url, true)
      if (parsed.pathname !== '/auth/callback') return

      const authCode = parsed.query.code as string
      const error = parsed.query.error as string

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h2>Authorization failed: ${error}</h2><p>${parsed.query.error_description ?? ''}</p>`)
        server.close()
        reject(new Error(`Authorization denied: ${error}`))
        return
      }

      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h2>No code received.</h2>')
        server.close()
        reject(new Error('No authorization code received'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>✓ Authorization successful!</h2><p>You can close this tab.</p>')
      server.close()
      resolve(authCode)
    })

    server.listen(PORT)
    server.on('error', err => reject(new Error(`Server error on port ${PORT}: ${err.message}`)))
    setTimeout(() => { server.close(); reject(new Error('Authorization timed out (15 min)')) }, TIMEOUT_MS)
  })

  // Exchange code for tokens
  const result = await msalApp.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
  })

  if (!result) {
    console.error('ERROR: Token exchange returned null.')
    process.exit(1)
  }

  // Persist the full MSAL cache (includes refresh token)
  const cacheData = msalApp.getTokenCache().serialize()
  if (!existsSync('./data')) await mkdir('./data', { recursive: true })
  await writeFile(CACHE_PATH, cacheData, 'utf-8')

  console.log('\n=== SUCCESS ===\n')
  console.log(`Account: ${result.account?.username ?? 'unknown'}`)
  console.log(`Token cache saved to: ${CACHE_PATH}`)
  console.log(`Scopes granted: ${result.scopes.join(', ')}`)
  console.log('\nThe relay can now send mail and read inbox for this account.')
}

main().catch(err => {
  console.error('Setup failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
