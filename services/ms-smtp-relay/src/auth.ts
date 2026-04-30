/**
 * Microsoft OAuth2 token management via MSAL.
 *
 * Uses authorization code flow with refresh token (delegated permissions).
 * Token cache is persisted to disk so the relay survives restarts.
 */

import { ConfidentialClientApplication, type Configuration, type AuthenticationResult } from '@azure/msal-node'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

const CACHE_PATH = process.env.TOKEN_CACHE_PATH ?? '/app/data/token-cache.json'
const SCOPES = ['Mail.Send', 'Mail.Read', 'offline_access', 'User.Read']

let msalApp: ConfidentialClientApplication | null = null

function getMsalConfig(): Configuration {
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const tenantId = process.env.AZURE_TENANT_ID ?? 'consumers'

  if (!clientId || !clientSecret) {
    throw new Error('Missing AZURE_CLIENT_ID or AZURE_CLIENT_SECRET env vars')
  }

  return {
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  }
}

async function loadCache(): Promise<string | undefined> {
  try {
    if (existsSync(CACHE_PATH)) {
      return await readFile(CACHE_PATH, 'utf-8')
    }
  } catch {
    // No cache yet — that's fine for first run
  }
  return undefined
}

async function saveCache(cache: string): Promise<void> {
  const dir = dirname(CACHE_PATH)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(CACHE_PATH, cache, 'utf-8')
}

export async function getMsalApp(): Promise<ConfidentialClientApplication> {
  if (msalApp) return msalApp

  const config = getMsalConfig()
  msalApp = new ConfidentialClientApplication(config)

  // Load persisted cache
  const cached = await loadCache()
  if (cached) {
    msalApp.getTokenCache().deserialize(cached)
  }

  return msalApp
}

export async function getAccessToken(): Promise<string> {
  const app = await getMsalApp()
  const cache = app.getTokenCache()
  const accounts = await cache.getAllAccounts()

  if (accounts.length === 0) {
    throw new Error(
      'No cached accounts found. Run `npm run auth` to complete the one-time Microsoft OAuth setup.'
    )
  }

  let result: AuthenticationResult | null = null
  try {
    result = await app.acquireTokenSilent({
      account: accounts[0],
      scopes: SCOPES,
    })
  } catch (err) {
    throw new Error(
      `Token refresh failed — you may need to re-run \`npm run auth\`. Error: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if (!result?.accessToken) {
    throw new Error('Failed to acquire access token')
  }

  // Persist updated cache (refresh token may have rotated)
  const serialized = cache.serialize()
  await saveCache(serialized)

  return result.accessToken
}

export { SCOPES }
