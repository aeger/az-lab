import fs from 'fs'
import path from 'path'

const HEALTH_PATH = path.join(process.cwd(), 'data', 'feed-health.json')

export interface FeedHealth {
  ok: boolean
  checkedAt: string
  lastSuccess?: string     // ISO timestamp of last successful fetch
  itemCount?: number
  error?: string
  fetchDurationMs?: number // how long the last fetch took
}

type HealthMap = Record<string, FeedHealth>

function read(): HealthMap {
  try { return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf-8')) }
  catch { return {} }
}

function write(map: HealthMap) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true })
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(map, null, 2))
  } catch {}
}

export function recordFeedResult(
  url: string,
  ok: boolean,
  itemCount?: number,
  error?: string,
  fetchDurationMs?: number,
) {
  const map = read()
  const prev = map[url]
  const now = new Date().toISOString()
  map[url] = {
    ok,
    checkedAt: now,
    // Preserve lastSuccess: set it on success, carry forward previous value on failure
    lastSuccess: ok ? now : (prev?.lastSuccess ?? undefined),
    ...(itemCount !== undefined && { itemCount }),
    ...(error && { error }),
    ...(fetchDurationMs !== undefined && { fetchDurationMs }),
  }
  write(map)
}

export function getFeedHealth(): HealthMap {
  return read()
}
