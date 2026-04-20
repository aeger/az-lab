import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
])

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return new NextResponse('Missing url', { status: 400 })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return new NextResponse('Invalid URL', { status: 400 })
  }

  // Only allow http/https
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return new NextResponse('Unsupported protocol', { status: 400 })
  }

  try {
    const upstream = await fetch(parsedUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AZLabDashboard/1.0)',
        Accept: 'image/*',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!upstream.ok) {
      return new NextResponse('Upstream fetch failed', { status: 502 })
    }

    const contentType = upstream.headers.get('content-type') ?? ''
    const mimeType = contentType.split(';')[0].trim()

    if (!ALLOWED_CONTENT_TYPES.has(mimeType)) {
      return new NextResponse('Not an image', { status: 415 })
    }

    const body = await upstream.arrayBuffer()

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'Content-Length': String(body.byteLength),
      },
    })
  } catch (err) {
    return new NextResponse(`Proxy error: ${String(err)}`, { status: 502 })
  }
}
