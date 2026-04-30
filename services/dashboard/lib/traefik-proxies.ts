import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

const DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/traefik-dynamic'

// Files that are infrastructure-managed and should not be editable via the UI
const PROTECTED_FILES = new Set([
  'authelia',
  'lan-middlewares',
  'tls-home-arpa',
])

export interface ProxyConfig {
  name: string
  hostname: string
  backendUrl: string
  lanOnly: boolean
  auth: boolean
  tls: boolean
  staticIp: string
}

// ── YAML generation ──────────────────────────────────────────────────────────

function buildYaml(cfg: ProxyConfig): string {
  const middlewares: string[] = []
  if (cfg.lanOnly) middlewares.push('lan-allow@file')
  if (cfg.auth) middlewares.push('authelia-auth@file')

  const router: Record<string, unknown> = {
    rule: `Host(\`${cfg.hostname}\`)`,
    entryPoints: ['websecure'],
    service: cfg.name,
  }

  if (cfg.tls) {
    router.tls = { certResolver: 'le' }
  }

  if (middlewares.length > 0) {
    router.middlewares = middlewares
  }

  const doc = {
    http: {
      routers: { [cfg.name]: router },
      services: {
        [cfg.name]: {
          loadBalancer: {
            servers: [{ url: cfg.backendUrl }],
          },
        },
      },
    },
  }

  return yaml.dump(doc, { lineWidth: -1 })
}

// ── Parse existing YAML back into ProxyConfig ────────────────────────────────

function parseYaml(name: string, content: string): ProxyConfig | null {
  try {
    const doc = yaml.load(content) as Record<string, unknown>
    const http = doc?.http as Record<string, unknown> | undefined
    if (!http) return null

    const routers = http.routers as Record<string, unknown> | undefined
    const services = http.services as Record<string, unknown> | undefined
    const router = routers?.[name] as Record<string, unknown> | undefined
    const service = services?.[name] as Record<string, unknown> | undefined

    if (!router || !service) return null

    // Extract hostname from rule like: Host(`homebridge.az-lab.dev`)
    const rule = router.rule as string
    const hostnameMatch = rule?.match(/Host\(`([^`]+)`\)/)
    const hostname = hostnameMatch?.[1] ?? ''

    // Extract backend URL
    const lb = (service as Record<string, unknown>).loadBalancer as Record<string, unknown> | undefined
    const servers = lb?.servers as Array<{ url: string }> | undefined
    const backendUrl = servers?.[0]?.url ?? ''

    const middlewares = (router.middlewares as string[]) ?? []

    return {
      name,
      hostname,
      backendUrl,
      lanOnly: middlewares.includes('lan-allow@file'),
      auth: middlewares.includes('authelia-auth@file'),
      tls: router.tls != null,
      staticIp: '',
    }
  } catch {
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function listProxies(): ProxyConfig[] {
  try {
    const files = fs.readdirSync(DYNAMIC_DIR).filter((f) => f.endsWith('.yml'))
    const configs: ProxyConfig[] = []
    for (const file of files) {
      const name = file.replace('.yml', '')
      if (PROTECTED_FILES.has(name)) continue
      const content = fs.readFileSync(path.join(DYNAMIC_DIR, file), 'utf-8')
      const cfg = parseYaml(name, content)
      if (cfg) configs.push(cfg)
    }
    return configs.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function getProxy(name: string): ProxyConfig | null {
  if (!isValidName(name)) return null
  const filePath = path.join(DYNAMIC_DIR, `${name}.yml`)
  if (!fs.existsSync(filePath)) return null
  const content = fs.readFileSync(filePath, 'utf-8')
  return parseYaml(name, content)
}

export function writeProxy(cfg: ProxyConfig): void {
  const filePath = path.join(DYNAMIC_DIR, `${cfg.name}.yml`)
  fs.writeFileSync(filePath, buildYaml(cfg), 'utf-8')
}

export function deleteProxy(name: string): boolean {
  if (!isValidName(name)) return false
  const filePath = path.join(DYNAMIC_DIR, `${name}.yml`)
  if (!fs.existsSync(filePath)) return false
  fs.unlinkSync(filePath)
  return true
}

export function proxyExists(name: string): boolean {
  if (!isValidName(name)) return false
  return fs.existsSync(path.join(DYNAMIC_DIR, `${name}.yml`))
}

export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !PROTECTED_FILES.has(name)
}

export function isValidHostname(hostname: string): boolean {
  return /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)
}

export function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
