import { NextRequest, NextResponse } from 'next/server'
import { saveRefreshToken } from '@/lib/gmail'

// Handles OAuth callback from Google — exchanges code for tokens, saves refresh token
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'home.az-lab.dev'
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const origin = `${proto}://${host}`
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    const msg = error || 'No authorization code received'
    return NextResponse.redirect(`${origin}/?gmail_auth=error&reason=${encodeURIComponent(msg)}`)
  }

  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${origin}/?gmail_auth=error&reason=missing_credentials`)
  }

  const redirectUri = `${origin}/api/gmail/auth/callback`

  const codeVerifier = req.cookies.get('gmail_pkce_verifier')?.value

  try {
    const tokenParams: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }
    if (codeVerifier) tokenParams.code_verifier = codeVerifier

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('Gmail token exchange failed:', res.status, body)
      return NextResponse.redirect(
        `${origin}/?gmail_auth=error&reason=${encodeURIComponent(`Token exchange failed: ${res.status}`)}`,
      )
    }

    const data = await res.json()

    if (!data.refresh_token) {
      // This happens if the user already granted access and Google didn't re-issue a refresh token.
      // The auth URL uses prompt=consent to force it, so this shouldn't happen normally.
      return NextResponse.redirect(
        `${origin}/?gmail_auth=error&reason=no_refresh_token`,
      )
    }

    saveRefreshToken(data.refresh_token)

    const successRes = NextResponse.redirect(`${origin}/?gmail_auth=success`)
    successRes.cookies.delete('gmail_pkce_verifier')
    return successRes
  } catch (err) {
    console.error('Gmail auth callback error:', err)
    return NextResponse.redirect(
      `${origin}/?gmail_auth=error&reason=unexpected_error`,
    )
  }
}
