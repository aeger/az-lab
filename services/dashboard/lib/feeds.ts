import fs from 'fs'
import path from 'path'
import { getConfig, type NewsFeed } from './config'

const FEEDS_PATH = path.join(process.cwd(), 'data', 'feeds.json')

interface FeedsData {
  family?: NewsFeed[]
  lab?: NewsFeed[]
}

function readFeedsFile(): FeedsData {
  try {
    return JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Returns the active feed list for a given type.
 * Prefers data/feeds.json (UI-saved) over dashboard.yaml (defaults).
 */
export function getFeeds(type: 'family' | 'lab'): NewsFeed[] {
  const saved = readFeedsFile()
  if (saved[type] !== undefined) return saved[type]!

  const config = getConfig()
  return type === 'lab' ? config.lab.tech_news_feeds : config.family.news_feeds
}

export function saveFeeds(type: 'family' | 'lab', feeds: NewsFeed[]): void {
  const current = readFeedsFile()
  const updated: FeedsData = { ...current, [type]: feeds }
  fs.mkdirSync(path.dirname(FEEDS_PATH), { recursive: true })
  fs.writeFileSync(FEEDS_PATH, JSON.stringify(updated, null, 2))
}
