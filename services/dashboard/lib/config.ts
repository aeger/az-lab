import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

export interface QuickLink {
  name: string
  url: string
  icon?: string
  color?: string
}

export interface NewsFeed {
  url: string
  name: string
}

export interface Host {
  name: string
  node_exporter_instance: string
}

export interface DashboardConfig {
  site: {
    title: string
    family_name: string
  }
  weather: {
    latitude: number
    longitude: number
    location: string
    units: 'imperial' | 'metric'
  }
  family: {
    photo_interval_seconds: number
    quick_links: QuickLink[]
    news_feeds: NewsFeed[]
  }
  lab: {
    prometheus_url: string
    adguard_url: string
    portainer_url: string
    hosts: Host[]
    quick_links: QuickLink[]
    tech_news_feeds: NewsFeed[]
  }
  homeassistant?: {
    url: string
    default_dashboard: string
    dashboards?: { title: string; path: string }[]
  }
}

let _config: DashboardConfig | null = null

export function getConfig(): DashboardConfig {
  if (_config) return _config

  const configPath = path.join(process.cwd(), 'config', 'dashboard.yaml')
  const raw = fs.readFileSync(configPath, 'utf-8')
  _config = yaml.load(raw) as DashboardConfig
  return _config
}
