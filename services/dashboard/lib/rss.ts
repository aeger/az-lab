import Parser from 'rss-parser'
import { recordFeedResult } from './feed-health'

export interface RssItem {
  title: string
  link: string
  pubDate: string
  source: string
  summary?: string      // Plain text description/snippet
  imageUrl?: string     // Thumbnail or enclosure image URL
  feedType?: 'lab' | 'family'
}

const parser = new Parser<Record<string, never>, {
  'media:content'?: { $: { url: string; medium?: string } }
  'media:thumbnail'?: { $: { url: string } }
  'media:group'?: { 'media:thumbnail'?: Array<{ $: { url: string } }> }
}>({
  timeout: 10000,
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
      ['media:group', 'media:group'],
    ],
  },
  headers: {
    'User-Agent': 'AZ-Lab-Dashboard/1.0 (homelab monitoring; self-hosted)',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
})

function isRedditUrl(url: string): boolean {
  return /reddit\.com\/r\//i.test(url)
}

function extractImage(item: Parser.Item & {
  'media:content'?: { $: { url: string; medium?: string } }
  'media:thumbnail'?: { $: { url: string } }
  'media:group'?: { 'media:thumbnail'?: Array<{ $: { url: string } }> }
}): string | undefined {
  const enclosureUrl = item.enclosure?.url
  if (enclosureUrl && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(enclosureUrl)) return enclosureUrl

  const mc = item['media:content']
  if (mc?.$?.url) return mc.$.url

  const mt = item['media:thumbnail']
  if (mt?.$?.url) return mt.$.url

  const mg = item['media:group']
  const mgThumb = mg?.['media:thumbnail']?.[0]?.$?.url
  if (mgThumb) return mgThumb

  return undefined
}

function extractSummary(item: Parser.Item): string | undefined {
  const raw = item.contentSnippet || item.summary || ''
  const trimmed = raw.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed.length < 10) return undefined
  return trimmed.length > 500 ? trimmed.slice(0, 497) + '…' : trimmed
}

// Reddit's JSON API is more reliable than their RSS for automated clients
async function fetchRedditJson(
  url: string, name: string, limit: number, feedType?: 'lab' | 'family'
): Promise<RssItem[]> {
  const match = url.match(/reddit\.com\/r\/([^/.]+)/i)
  if (!match) throw new Error('Could not parse subreddit from URL')

  const subreddit = match[1]
  const jsonUrl = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`

  const res = await fetch(jsonUrl, {
    headers: { 'User-Agent': 'AZ-Lab-Dashboard/1.0 (homelab monitoring; self-hosted)' },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`Reddit JSON API returned ${res.status}`)

  const data = await res.json()
  return (data.data?.children ?? [])
    .filter((c: { data: { stickied: boolean } }) => !c.data?.stickied)
    .slice(0, limit)
    .map((c: {
      data: {
        title: string
        permalink: string
        created_utc: number
        selftext?: string
        thumbnail?: string
        url?: string
        score?: number
      }
    }) => {
      const thumb = c.data.thumbnail
      const imageUrl = thumb && thumb.startsWith('http') ? thumb : undefined
      const selftext = c.data.selftext?.trim()
      const summary = selftext && selftext.length > 0 && selftext !== '[removed]' && selftext !== '[deleted]'
        ? selftext.slice(0, 400) + (selftext.length > 400 ? '…' : '')
        : undefined

      return {
        title: c.data.title,
        link: `https://www.reddit.com${c.data.permalink}`,
        pubDate: new Date(c.data.created_utc * 1000).toISOString(),
        source: name,
        summary,
        imageUrl,
        feedType,
      }
    })
}

// Normalize a URL to a canonical fingerprint for deduplication.
// Strips tracking params, normalizes scheme to https, removes trailing slash.
export function urlFingerprint(url: string): string {
  try {
    const u = new URL(url)
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
      'fbclid', 'gclid', 'gclsrc', 'mc_eid', 'yclid', 'msclkid', '_ga', 'ref', 'source',
    ]
    for (const p of trackingParams) u.searchParams.delete(p)
    u.hostname = u.hostname.toLowerCase()
    if (u.protocol === 'http:') u.protocol = 'https:'
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1)
    }
    return u.toString()
  } catch {
    return url
  }
}

async function fetchOneFeed(
  feed: { url: string; name: string },
  limit: number,
  feedType?: 'lab' | 'family'
): Promise<RssItem[]> {
  const t0 = Date.now()
  try {
    let items: RssItem[]
    if (isRedditUrl(feed.url)) {
      items = await fetchRedditJson(feed.url, feed.name, limit, feedType)
    } else {
      const parsed = await parser.parseURL(feed.url)
      items = (parsed.items ?? []).slice(0, limit).map((item) => ({
        title: item.title ?? '',
        link: item.link ?? '',
        pubDate: item.pubDate ?? item.isoDate ?? '',
        source: feed.name,
        summary: extractSummary(item),
        imageUrl: extractImage(item),
        feedType,
      }))
    }
    recordFeedResult(feed.url, true, items.length, undefined, Date.now() - t0)
    return items
  } catch (err) {
    recordFeedResult(feed.url, false, undefined, String(err).replace(/^Error:\s*/, '').slice(0, 120), Date.now() - t0)
    throw err
  }
}

export async function fetchRssFeeds(
  feeds: { url: string; name: string }[],
  limit = 10,
  feedType?: 'lab' | 'family'
): Promise<RssItem[]> {
  const results = await Promise.allSettled(feeds.map((feed) => fetchOneFeed(feed, limit, feedType)))

  const items: RssItem[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value)
    }
  }

  // Deduplicate by URL fingerprint (strips tracking params, normalizes scheme/trailing slash)
  const seen = new Set<string>()
  return items
    .filter((i) => i.title && i.link)
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .filter((i) => {
      const fp = urlFingerprint(i.link)
      if (seen.has(fp)) return false
      seen.add(fp)
      return true
    })
    .slice(0, limit * feeds.length)
}

export interface CalendarEvent {
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
}

export async function fetchCalendarEvents(icalUrl: string): Promise<CalendarEvent[]> {
  if (!icalUrl) return []

  try {
    const ical = await import('node-ical')
    const data = await ical.async.fromURL(icalUrl)
    const now = new Date()
    const oneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    const events: CalendarEvent[] = []

    for (const event of Object.values(data)) {
      if (!event || event.type !== 'VEVENT') continue

      const e = event as {
        summary?: string
        start?: Date
        end?: Date
        datetype?: string
        location?: string
      }

      if (!e.start) continue

      const start = new Date(e.start)
      if (start < now || start > oneWeek) continue

      events.push({
        title: e.summary ?? 'Event',
        start: start.toISOString(),
        end: e.end ? new Date(e.end).toISOString() : start.toISOString(),
        allDay: e.datetype === 'date',
        location: e.location,
      })
    }

    return events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  } catch {
    return []
  }
}
