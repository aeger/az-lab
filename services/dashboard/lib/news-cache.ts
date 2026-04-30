import fs from 'fs'
import path from 'path'
import type { RssItem } from './rss'

const DATA_DIR = path.join(process.cwd(), 'data')
const TTL_MS = 30 * 60 * 1000 // attempt refresh after 30 min

interface CacheFile {
  fetchedAt: string
  items: RssItem[]
}

function cachePath(type: string) {
  return path.join(DATA_DIR, `news-${type}.json`)
}

function readCache(type: string): CacheFile | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(type), 'utf-8'))
  } catch {
    return null
  }
}

function writeCache(type: string, items: RssItem[]) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const data: CacheFile = { fetchedAt: new Date().toISOString(), items }
    fs.writeFileSync(cachePath(type), JSON.stringify(data))
  } catch { /* non-fatal */ }
}

export function clearNewsCache(type: string): void {
  try { fs.unlinkSync(cachePath(type)) } catch { /* already gone or unwritable */ }
}

export interface NewsResult {
  items: RssItem[]
  cachedAt: string | null // null = freshly fetched
}

export async function getCachedNews(
  type: string,
  fetcher: () => Promise<RssItem[]>
): Promise<NewsResult> {
  const cache = readCache(type)
  const now = Date.now()

  if (cache) {
    const age = now - new Date(cache.fetchedAt).getTime()

    if (age < TTL_MS) {
      // Cache is fresh — serve without fetching
      return { items: cache.items, cachedAt: cache.fetchedAt }
    }

    // Cache is stale — attempt refresh, fall back to stale on any failure
    try {
      const items = await fetcher()
      if (items.length > 0) {
        writeCache(type, items)
        return { items, cachedAt: null }
      }
      // Empty result (throttled / all feeds failed) — serve stale
      return { items: cache.items, cachedAt: cache.fetchedAt }
    } catch {
      return { items: cache.items, cachedAt: cache.fetchedAt }
    }
  }

  // No cache on disk — fetch fresh (first run or data dir wiped)
  const items = await fetcher()
  if (items.length > 0) writeCache(type, items)
  return { items, cachedAt: null }
}
