import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RustDeskRemote } from '@/app/api/rustdesk/remotes/route'

const DB_PATH      = '/app/rustdesk-data/db_v2.sqlite3'
const REMOTES_FILE = join(process.cwd(), 'data', 'rustdesk_remotes.json')

export interface PeerInfo {
  peerId: string
  lastSeen: string   // ISO timestamp
  ip: string
  inRemotes: boolean
}

function readRemotes(): RustDeskRemote[] {
  if (!existsSync(REMOTES_FILE)) return []
  try { return JSON.parse(readFileSync(REMOTES_FILE, 'utf-8')) } catch { return [] }
}

function writeRemotes(r: RustDeskRemote[]) {
  writeFileSync(REMOTES_FILE, JSON.stringify(r, null, 2) + '\n')
}

function readPeers(): PeerInfo[] {
  if (!existsSync(DB_PATH)) return []
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    const rows = db.prepare('SELECT id, created_at, info FROM peer ORDER BY created_at DESC').all() as {
      id: string; created_at: string; info: string
    }[]
    db.close()
    return rows.map(r => {
      let ip = ''
      try { ip = (JSON.parse(r.info)?.ip ?? '').replace('::ffff:', '') } catch {}
      return { peerId: r.id, lastSeen: r.created_at, ip, inRemotes: false }
    })
  } catch (e) {
    console.error('rustdesk sync: db read error', e)
    return []
  }
}

// GET — returns peers from DB cross-referenced with saved remotes
export async function GET() {
  const peers = readPeers()
  const remotes = readRemotes()
  const remoteIds = new Set(remotes.map(r => r.peerId))
  return NextResponse.json({
    peers: peers.map(p => ({ ...p, inRemotes: remoteIds.has(p.peerId) })),
    remoteCount: remotes.length,
    dbAvailable: existsSync(DB_PATH),
  })
}

// POST — trigger auto-sync: add new peers, remove stale, update last_seen metadata
export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') ?? ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const peers = readPeers()
  if (peers.length === 0) return NextResponse.json({ added: 0, removed: 0, unchanged: 0 })

  const dbIds = new Set(peers.map(p => p.peerId))
  const lastSeenMap = Object.fromEntries(peers.map(p => [p.peerId, p.lastSeen]))
  const ipMap = Object.fromEntries(peers.map(p => [p.peerId, p.ip]))

  let remotes = readRemotes()
  let added = 0, removed = 0, unchanged = 0

  // Add peers in DB but not in remotes
  for (const peer of peers) {
    if (!remotes.some(r => r.peerId === peer.peerId)) {
      const ip = peer.ip
      const autoName = ip
        ? `peer-${peer.peerId.slice(-4)} (${ip})`
        : `peer-${peer.peerId.slice(-4)}`
      remotes.push({
        id: randomUUID(),
        peerId: peer.peerId,
        name: autoName,
        note: `Auto-added from relay DB. Last seen: ${peer.lastSeen}`,
      })
      added++
    }
  }

  // Remove remotes whose peer ID is no longer in the DB
  const before = remotes.length
  remotes = remotes.filter(r => dbIds.has(r.peerId))
  removed = before - remotes.length - added  // net removals

  // Update notes with latest last_seen for auto-added entries
  for (const r of remotes) {
    if (r.note?.startsWith('Auto-added')) {
      const ls = lastSeenMap[r.peerId]
      const ip = ipMap[r.peerId]
      if (ls) r.note = `Auto-added from relay DB. Last seen: ${ls}${ip ? ` · IP: ${ip}` : ''}`
    }
    unchanged++
  }
  unchanged = remotes.length - added

  writeRemotes(remotes)
  return NextResponse.json({ added, removed, unchanged })
}
