import { NextResponse } from 'next/server'
import { fetchRssFeeds } from '@/lib/rss'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')

  if (!url) return NextResponse.json({ ok: false, error: 'url param required' }, { status: 400 })

  try {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol)) {
      return NextResponse.json({ ok: false, error: 'URL must be http or https' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid URL' }, { status: 400 })
  }

  try {
    const items = await fetchRssFeeds([{ url, name: 'test' }], 5)
    if (items.length === 0) {
      return NextResponse.json({ ok: false, error: 'Feed parsed but returned no items' })
    }
    return NextResponse.json({
      ok: true,
      itemCount: items.length,
      preview: items.slice(0, 3).map((i) => ({ title: i.title, pubDate: i.pubDate })),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err).replace(/^Error:\s*/, '') })
  }
}
