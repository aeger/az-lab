import fs from 'fs'
import path from 'path'
import { getConfig, type QuickLink } from './config'

const QL_PATH = path.join(process.cwd(), 'data', 'quicklinks.json')

interface QuickLinksData {
  home?: QuickLink[]
  lab?: QuickLink[]
}

function readFile(): QuickLinksData {
  try {
    return JSON.parse(fs.readFileSync(QL_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function getQuickLinks(section: 'home' | 'lab'): QuickLink[] {
  const saved = readFile()
  if (saved[section] !== undefined) return saved[section]!
  const config = getConfig()
  return section === 'home' ? (config.family.quick_links ?? []) : (config.lab.quick_links ?? [])
}

export function getAllQuickLinks(): { home: QuickLink[]; lab: QuickLink[] } {
  return { home: getQuickLinks('home'), lab: getQuickLinks('lab') }
}

export function saveQuickLinks(section: 'home' | 'lab', links: QuickLink[]): void {
  const current = readFile()
  const updated: QuickLinksData = { ...current, [section]: links }
  fs.mkdirSync(path.dirname(QL_PATH), { recursive: true })
  fs.writeFileSync(QL_PATH, JSON.stringify(updated, null, 2))
}
