/**
 * news-intel.ts — Phase 2 Intelligence Layer
 *
 * Batch-analyzes news items via Nemotron to produce:
 *   - tldr:  1-sentence AI summary
 *   - score: importance 1–10
 *   - topic: cluster label
 *
 * Results are cached in data/news-intel.json keyed by URL fingerprint.
 * Cache entries expire after CACHE_TTL_MS (24 h) so stale summaries refresh.
 */

import fs from 'fs'
import path from 'path'
import type { RssItem } from './rss'
import { urlFingerprint } from './rss'

const NVIDIA_NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const NEMOTRON_MODEL  = 'nvidia/nemotron-super-49b-instruct'
const API_KEY_FILE    = path.join(process.env.HOME ?? '/root', '.nvidia_api_key')
const INTEL_CACHE     = path.join(process.cwd(), 'data', 'news-intel.json')
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000   // 24 h
const BATCH_SIZE      = 10
const REQUEST_TIMEOUT = 45_000                  // 45 s per batch

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArticleIntel {
  fp:       string  // URL fingerprint (cache key)
  tldr:     string  // 1-sentence summary
  score:    number  // 1–10 importance
  topic:    string  // cluster label
  cachedAt: string  // ISO timestamp
}

export interface EnrichedRssItem extends RssItem {
  intel?: ArticleIntel
}

export interface TopicCluster {
  topic: string
  items: EnrichedRssItem[]
}

export interface DigestItem {
  title:   string
  link:    string
  source:  string
  tldr:    string
  score:   number
  pubDate: string
}

export interface DigestSection {
  topic:    string
  topItems: DigestItem[]
}

// ─── Allowed topics ───────────────────────────────────────────────────────────

export const TOPICS = [
  'AI & Machine Learning',
  'Security & Privacy',
  'Hardware & Infrastructure',
  'Software & Dev Tools',
  'Gaming',
  'Science & Space',
  'Finance & Economy',
  'Health & Medicine',
  'Politics & Society',
  'Other',
] as const

type Topic = typeof TOPICS[number]

function isValidTopic(t: string): t is Topic {
  return (TOPICS as readonly string[]).includes(t)
}

// ─── Cache I/O ────────────────────────────────────────────────────────────────

type IntelCacheFile = Record<string, ArticleIntel>

function readCache(): IntelCacheFile {
  try {
    return JSON.parse(fs.readFileSync(INTEL_CACHE, 'utf-8'))
  } catch {
    return {}
  }
}

function writeCache(cache: IntelCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(INTEL_CACHE), { recursive: true })
    fs.writeFileSync(INTEL_CACHE, JSON.stringify(cache))
  } catch { /* non-fatal */ }
}

function isStale(entry: ArticleIntel): boolean {
  return Date.now() - new Date(entry.cachedAt).getTime() > CACHE_TTL_MS
}

// ─── Nemotron API ─────────────────────────────────────────────────────────────

function getNvidiaKey(): string | null {
  try { return fs.readFileSync(API_KEY_FILE, 'utf-8').trim() } catch {}
  return process.env.NVIDIA_API_KEY ?? null
}

async function callNemotron(prompt: string): Promise<string | null> {
  const key = getNvidiaKey()
  if (!key) return null

  try {
    const res = await fetch(NVIDIA_NIM_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model:       NEMOTRON_MODEL,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  2048,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    if (!res.ok) {
      console.error(`[news-intel] Nemotron ${res.status}: ${await res.text().catch(() => '')}`)
      return null
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? null
  } catch (err) {
    console.error('[news-intel] Nemotron call failed:', err)
    return null
  }
}

// ─── Batch analysis ───────────────────────────────────────────────────────────

function fallbackIntel(item: RssItem): ArticleIntel {
  return {
    fp:       urlFingerprint(item.link),
    tldr:     '',
    score:    5,
    topic:    'Other',
    cachedAt: new Date().toISOString(),
  }
}

async function analyzeBatch(items: RssItem[]): Promise<ArticleIntel[]> {
  const articleList = items
    .map((it, i) => `${i + 1}. Title: ${it.title}\nSnippet: ${it.summary?.slice(0, 200) ?? '(none)'}`)
    .join('\n\n')

  const topicList = TOPICS.join(' | ')

  const prompt = `You are a concise news analyst. For each article, output:
- tldr: One sentence (max 25 words) capturing the core news
- score: Integer 1-10 (10=breaking/critical, 7-9=highly relevant, 4-6=moderate, 1-3=minor)
- topic: Exactly one of: ${topicList}

Respond with ONLY a JSON array — no markdown, no commentary, no trailing text:
[{"tldr":"...","score":8,"topic":"AI & Machine Learning"}, ...]

Articles:
${articleList}`

  const raw = await callNemotron(prompt)
  if (!raw) return items.map(fallbackIntel)

  try {
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('no JSON array in response')
    const parsed: Array<{ tldr?: string; score?: number; topic?: string }> = JSON.parse(match[0])
    const now = new Date().toISOString()

    return items.map((item, i) => {
      const p = parsed[i] ?? {}
      return {
        fp:       urlFingerprint(item.link),
        tldr:     typeof p.tldr === 'string' ? p.tldr.trim().slice(0, 200) : '',
        score:    Math.min(10, Math.max(1, Math.round(typeof p.score === 'number' ? p.score : 5))),
        topic:    isValidTopic(p.topic ?? '') ? (p.topic as Topic) : 'Other',
        cachedAt: now,
      }
    })
  } catch (err) {
    console.error('[news-intel] parse failed:', err, '\nRaw:', raw.slice(0, 300))
    return items.map(fallbackIntel)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enriches a list of RssItems with AI intel.
 * Only calls Nemotron for items not already in the cache (or whose cache is stale).
 * Returns a Map keyed by URL fingerprint.
 */
export async function enrichItems(items: RssItem[]): Promise<Map<string, ArticleIntel>> {
  const cache   = readCache()
  const result  = new Map<string, ArticleIntel>()
  const missing: RssItem[] = []

  for (const item of items) {
    const fp    = urlFingerprint(item.link)
    const entry = cache[fp]
    if (entry && !isStale(entry)) {
      result.set(fp, entry)
    } else {
      missing.push(item)
    }
  }

  // Process missing items in batches
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    const intel = await analyzeBatch(batch)
    for (const entry of intel) {
      cache[entry.fp] = entry
      result.set(entry.fp, entry)
    }
  }

  if (missing.length > 0) writeCache(cache)

  return result
}

/**
 * Groups enriched items into topic clusters sorted by aggregate importance.
 */
export function clusterByTopic(
  items: RssItem[],
  intelMap: Map<string, ArticleIntel>
): TopicCluster[] {
  const clusters = new Map<string, EnrichedRssItem[]>()

  for (const item of items) {
    const fp    = urlFingerprint(item.link)
    const intel = intelMap.get(fp)
    if (!intel) continue
    const topic = intel.topic
    if (!clusters.has(topic)) clusters.set(topic, [])
    clusters.get(topic)!.push({ ...item, intel })
  }

  return [...clusters.entries()]
    .map(([topic, clusterItems]) => ({
      topic,
      items: clusterItems.sort((a, b) => (b.intel?.score ?? 5) - (a.intel?.score ?? 5)),
    }))
    .sort((a, b) => {
      const scoreSum = (arr: EnrichedRssItem[]) =>
        arr.reduce((s, i) => s + (i.intel?.score ?? 5), 0)
      return scoreSum(b.items) - scoreSum(a.items)
    })
}

/**
 * Builds a smart daily digest: top 3 articles from the top 6 topic clusters.
 */
export function buildDailyDigest(clusters: TopicCluster[]): DigestSection[] {
  return clusters
    .filter((c) => c.items.length > 0)
    .slice(0, 6)
    .map((cluster) => ({
      topic: cluster.topic,
      topItems: cluster.items.slice(0, 3).map((item) => ({
        title:   item.title,
        link:    item.link,
        source:  item.source,
        tldr:    item.intel?.tldr ?? '',
        score:   item.intel?.score ?? 5,
        pubDate: item.pubDate,
      })),
    }))
}
