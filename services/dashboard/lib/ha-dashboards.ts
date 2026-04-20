import fs from 'fs'
import path from 'path'
import { getConfig } from './config'

export interface HADashboardEntry {
  title: string
  path: string
}

const DATA_PATH = path.join(process.cwd(), 'data', 'ha-dashboards.json')

function readFile(): HADashboardEntry[] | null {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Returns the active HA dashboard list.
 * Prefers data/ha-dashboards.json (UI-saved) over dashboard.yaml (defaults).
 */
export function getHADashboards(): HADashboardEntry[] {
  const saved = readFile()
  if (saved !== null) return saved

  const config = getConfig()
  return config.homeassistant?.dashboards ?? [
    { title: 'Dashboard', path: config.homeassistant?.default_dashboard ?? '/lovelace/0' }
  ]
}

export function saveHADashboards(dashboards: HADashboardEntry[]): void {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true })
  fs.writeFileSync(DATA_PATH, JSON.stringify(dashboards, null, 2))
}
