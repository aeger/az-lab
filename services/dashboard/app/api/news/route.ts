import { NextResponse } from 'next/server'
import { fetchRssFeeds } from '@/lib/rss'
import { getCachedNews } from '@/lib/news-cache'
import { getFeeds } from '@/lib/feeds'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rawType = searchParams.get('type')

  // Unified feed: merge lab + family tagged with feedType
  if (rawType === 'all') {
    const labFeeds = getFeeds('lab')
    const familyFeeds = getFeeds('family')

    const [labResult, familyResult] = await Promise.all([
      getCachedNews('lab', () => fetchRssFeeds(labFeeds, 25, 'lab')),
      getCachedNews('family', () => fetchRssFeeds(familyFeeds, 25, 'family')),
    ])

    const items = [
      ...labResult.items.map((i) => ({ ...i, feedType: 'lab' as const })),
      ...familyResult.items.map((i) => ({ ...i, feedType: 'family' as const })),
    ].sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())

    // cachedAt is oldest of the two (freshest only if both are fresh)
    const cachedAt = labResult.cachedAt ?? familyResult.cachedAt ?? null

    return NextResponse.json({ items, cachedAt })
  }

  const type = rawType === 'lab' ? 'lab' : 'family'
  const feeds = getFeeds(type)

  try {
    const { items, cachedAt } = await getCachedNews(type, () => fetchRssFeeds(feeds, 25, type))
    return NextResponse.json({ items, cachedAt })
  } catch {
    return NextResponse.json({ items: [], cachedAt: null })
  }
}
