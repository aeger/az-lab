import { NextRequest, NextResponse } from 'next/server'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const CACHE_DIR = join(process.cwd(), 'data', 'articles')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

interface ArticleCache {
  url: string
  title: string
  byline: string | null
  content: string
  textContent: string
  readingTime: number
  excerpt: string | null
  siteName: string | null
  cachedAt: string
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

function getCachePath(hash: string): string {
  return join(CACHE_DIR, `${hash}.json`)
}

function readCache(hash: string): ArticleCache | null {
  try {
    const raw = readFileSync(getCachePath(hash), 'utf8')
    const data: ArticleCache = JSON.parse(raw)
    const age = Date.now() - new Date(data.cachedAt).getTime()
    if (age > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(hash: string, data: ArticleCache) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(getCachePath(hash), JSON.stringify(data), 'utf8')
  } catch {}
}

function estimateReadingTime(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.max(1, Math.ceil(words / 200))
}

// Rewrite image src attributes to go through proxy
function proxyImages(html: string, baseUrl: string): string {
  // Resolve relative URLs and rewrite all img src to /api/proxy-image?url=...
  return html.replace(
    /<img([^>]*)\ssrc=["']([^"']+)["']([^>]*)>/gi,
    (match, before, src, after) => {
      try {
        const absolute = new URL(src, baseUrl).href
        const proxied = `/api/proxy-image?url=${encodeURIComponent(absolute)}`
        return `<img${before} src="${proxied}"${after}>`
      } catch {
        return match
      }
    }
  )
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  const hash = urlHash(url)

  // Return cached if fresh
  const cached = readCache(hash)
  if (cached) {
    return NextResponse.json(cached)
  }

  // Fetch article HTML server-side
  let html: string
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AZLabDashboard/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `Fetch failed: ${res.status} ${res.statusText}` },
        { status: 502 }
      )
    }
    // Limit to 500KB to keep jsdom memory reasonable
    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > 500 * 1024) {
      html = new TextDecoder().decode(buffer.slice(0, 500 * 1024))
    } else {
      html = new TextDecoder().decode(buffer)
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch article: ${String(err)}` },
      { status: 502 }
    )
  }

  // Parse with jsdom + Readability
  let article: ReturnType<Readability['parse']>
  try {
    const dom = new JSDOM(html, { url: parsedUrl.href })
    const reader = new Readability(dom.window.document)
    article = reader.parse()
  } catch (err) {
    return NextResponse.json(
      { error: `Extraction failed: ${String(err)}` },
      { status: 500 }
    )
  }

  if (!article) {
    return NextResponse.json(
      { error: 'Could not extract article content (paywall or unsupported format)' },
      { status: 422 }
    )
  }

  const content = proxyImages(article.content ?? '', parsedUrl.href)

  const result: ArticleCache = {
    url,
    title: article.title ?? '',
    byline: article.byline ?? null,
    content,
    textContent: article.textContent ?? '',
    readingTime: estimateReadingTime(article.textContent ?? ''),
    excerpt: article.excerpt ?? null,
    siteName: article.siteName ?? null,
    cachedAt: new Date().toISOString(),
  }

  writeCache(hash, result)

  return NextResponse.json(result)
}
