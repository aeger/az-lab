/**
 * GET /api/news/analyze
 *
 * Fetches the current cached news items, runs Nemotron enrichment for any
 * items not yet in the intel cache, and returns:
 *   - items:   EnrichedRssItem[] (intel field populated where available)
 *   - clusters: topic cluster summary
 *   - digest:   smart daily digest
 */

import { NextResponse } from 'next/server'
import { getCachedNews } from '@/lib/news-cache'
import { getFeeds } from '@/lib/feeds'
import { fetchRssFeeds, urlFingerprint } from '@/lib/rss'
import { enrichItems, clusterByTopic, buildDailyDigest } from '@/lib/news-intel'

export const dynamic = 'force-dynamic'

// Next.js server actions run in Node, give it plenty of time for Nemotron calls
export const maxDuration = 120

export async function GET() {
  try {
    const labFeeds    = getFeeds('lab')
    const familyFeeds = getFeeds('family')

    const [labResult, familyResult] = await Promise.all([
      getCachedNews('lab',    () => fetchRssFeeds(labFeeds,    25, 'lab')),
      getCachedNews('family', () => fetchRssFeeds(familyFeeds, 25, 'family')),
    ])

    const items = [
      ...labResult.items.map((i) => ({ ...i, feedType: 'lab' as const })),
      ...familyResult.items.map((i) => ({ ...i, feedType: 'family' as const })),
    ]

    const intelMap = await enrichItems(items)
    const clusters  = clusterByTopic(items, intelMap)
    const digest    = buildDailyDigest(clusters)

    const enrichedItems = items.map((item) => ({
      ...item,
      intel: intelMap.get(urlFingerprint(item.link)) ?? null,
    }))

    return NextResponse.json({
      items: enrichedItems,
      clusters: clusters.map((c) => ({ topic: c.topic, count: c.items.length })),
      digest,
      analyzedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[/api/news/analyze]', err)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }
}
