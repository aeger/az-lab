import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHash } from 'crypto'

// Initiates Gmail OAuth flow — sends user to Google consent screen
// Must be called from a browser (redirects).
export async function GET(req: NextRequest) {
  // Authelia check
  const cookie = req.headers.get('cookie') || ''
  try {
    const authRes = await fetch('https://auth.az-lab.dev/api/state', {
      headers: { cookie },
    })
    const authData = await authRes.json()
    if (!(authData.data?.authentication_level > 0 && authData.data?.username)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } catch {
    return NextResponse.json({ error: 'Auth check failed' }, { status: 500 })
  }

  const clientId = process.env.GMAIL_CLIENT_ID
  if (!clientId) {
    return NextResponse.json({ error: 'GMAIL_CLIENT_ID not configured' }, { status: 500 })
  }

  // Use forwarded host from Traefik — req.nextUrl.origin resolves to container internal address
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'home.az-lab.dev'
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const origin = `${proto}://${host}`
  const redirectUri = `${origin}/api/gmail/auth/callback`

  // PKCE: generate code_verifier and code_challenge
  const codeVerifier = randomBytes(64).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token to be issued
    state: 'gmail-reauth',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  const res = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  )
  // Store verifier in a short-lived cookie for the callback to use
  res.cookies.set('gmail_pkce_verifier', codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/api/gmail/auth',
  })
  return res
}
