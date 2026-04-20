#!/usr/bin/env node
/**
 * One-time OAuth2 setup script to generate a Gmail refresh token.
 *
 * Usage:
 *   1. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your shell:
 *        export GMAIL_CLIENT_ID=your_client_id
 *        export GMAIL_CLIENT_SECRET=your_client_secret
 *   2. Run:  npm run auth
 *   3. A browser window will open (or copy the URL manually)
 *   4. Sign in with your Google account and authorize
 *   5. Your GMAIL_REFRESH_TOKEN will be printed — add it to your MCP env config
 *
 * NOTE: Make sure "http://localhost:3000/callback" is in your OAuth client's
 *       Authorized Redirect URIs in Google Cloud Console.
 */

import { OAuth2Client } from 'google-auth-library'
import * as http from 'http'
import * as url from 'url'

const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
]
const REDIRECT_URI = 'http://localhost:3000/callback'
const PORT = 3000

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    console.error(
      'ERROR: Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables first.\n' +
        '  export GMAIL_CLIENT_ID=your_client_id\n' +
        '  export GMAIL_CLIENT_SECRET=your_client_secret'
    )
    process.exit(1)
  }

  const client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI)

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })

  console.log('\n=== Gmail MCP Server — Auth Setup ===\n')
  console.log('Opening your browser for Google authorization...')
  console.log('\nIf it does not open automatically, paste this URL into your browser:\n')
  console.log(authUrl)
  console.log('\nWaiting for authorization...\n')

  // Try to open browser automatically
  const { exec } = await import('child_process')
  const platform = process.platform
  const openCmd =
    platform === 'win32' ? `start "" "${authUrl}"` :
    platform === 'darwin' ? `open "${authUrl}"` :
    `xdg-open "${authUrl}"`
  exec(openCmd)

  // Start local server to catch the OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return
      const parsed = url.parse(req.url, true)
      if (parsed.pathname !== '/callback') return

      const authCode = parsed.query.code as string
      const error = parsed.query.error as string

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`)
        server.close()
        reject(new Error(`Authorization denied: ${error}`))
        return
      }

      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h2>No code received.</h2><p>You can close this tab.</p>')
        server.close()
        reject(new Error('No authorization code received'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<h2>✓ Authorization successful!</h2>' +
        '<p>You can close this tab and return to the terminal.</p>'
      )
      server.close()
      resolve(authCode)
    })

    server.listen(PORT, () => {
      // Server is ready
    })

    server.on('error', (err) => {
      reject(new Error(`Failed to start local server on port ${PORT}: ${(err as Error).message}`))
    })

    setTimeout(() => {
      server.close()
      reject(new Error('Authorization timed out after 5 minutes'))
    }, 5 * 60 * 1000)
  })

  const { tokens } = await client.getToken(code)

  if (!tokens.refresh_token) {
    console.error(
      '\nERROR: No refresh token was returned.\n' +
        'This usually means your Google account already authorized this app.\n' +
        'Fix: revoke access at https://myaccount.google.com/permissions then run this again.'
    )
    process.exit(1)
  }

  console.log('\n=== SUCCESS — Add these to your MCP environment config ===\n')
  console.log(`GMAIL_CLIENT_ID=${clientId}`)
  console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`)
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log(
    '\nIn Cowork/Claude Desktop, add these three env vars to your gmail-mcp-server entry.\n'
  )
}

main().catch((error) => {
  console.error('Setup failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
