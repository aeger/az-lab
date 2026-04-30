import { NextRequest, NextResponse } from 'next/server'
import { getFeeds, saveFeeds } from '@/lib/feeds'
import { clearNewsCache } from '@/lib/news-cache'
import { getFeedHealth } from '@/lib/feed-health'
import type { NewsFeed } from '@/lib/config'

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') === 'lab' ? 'lab' : 'family'
  return NextResponse.json({ feeds: getFeeds(type), health: getFeedHealth() })
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET ?? 'changeme'
  const auth = req.headers.get('authorization') ?? ''

  if (auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { type?: unknown; feeds?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const type = body.type === 'lab' ? 'lab' : 'family'

  if (!Array.isArray(body.feeds)) {
    return NextResponse.json({ error: 'feeds must be an array' }, { status: 400 })
  }

  if (body.feeds.length === 0) {
    return NextResponse.json({ error: 'At least one feed is required' }, { status: 400 })
  }

  if (body.feeds.length > 15) {
    return NextResponse.json({ error: 'Maximum of 15 feeds allowed' }, { status: 400 })
  }

  const feeds: NewsFeed[] = []
  for (const item of body.feeds) {
    if (typeof item !== 'object' || item === null) {
      return NextResponse.json({ error: 'Each feed must be an object' }, { status: 400 })
    }
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''

    if (!url) return NextResponse.json({ error: 'Each feed must have a non-empty url' }, { status: 400 })
    if (!name) return NextResponse.json({ error: 'Each feed must have a non-empty name' }, { status: 400 })

    try {
      const u = new URL(url)
      if (!['http:', 'https:'].includes(u.protocol)) {
        return NextResponse.json({ error: `Feed URL must use http or https: ${url}` }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: `Invalid URL: ${url}` }, { status: 400 })
    }

    feeds.push({ url, name })
  }

  // Check for duplicate URLs
  const urls = feeds.map((f) => f.url)
  if (new Set(urls).size !== urls.length) {
    return NextResponse.json({ error: 'Duplicate feed URLs are not allowed' }, { status: 400 })
  }

  saveFeeds(type, feeds)
  clearNewsCache(type) // force fresh fetch with new feed list

  return NextResponse.json({ feeds: getFeeds(type) })
}
