import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const DATA_FILE = join(process.cwd(), 'data', 'rustdesk_remotes.json')

export interface RustDeskRemote {
  id: string        // internal UUID
  peerId: string    // RustDesk peer ID (numeric string)
  name: string      // friendly name
  password?: string // optional saved password
  group?: string    // tag / category
  note?: string
}

function readRemotes(): RustDeskRemote[] {
  if (!existsSync(DATA_FILE)) return []
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf-8')) } catch { return [] }
}

function writeRemotes(remotes: RustDeskRemote[]) {
  writeFileSync(DATA_FILE, JSON.stringify(remotes, null, 2) + '\n')
}

function authOk(req: NextRequest) {
  return req.headers.get('cookie')?.includes('authelia_session')
}

export async function GET() {
  return NextResponse.json(readRemotes())
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { peerId, name, password, group, note } = body

    if (!peerId || typeof peerId !== 'string' || !/^\d+$/.test(peerId.trim())) {
      return NextResponse.json({ error: 'Invalid peer ID — must be numeric' }, { status: 400 })
    }
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const remotes = readRemotes()
    if (remotes.some((r) => r.peerId === peerId.trim())) {
      return NextResponse.json({ error: 'Peer ID already exists' }, { status: 409 })
    }

    const remote: RustDeskRemote = {
      id: randomUUID(),
      peerId: peerId.trim(),
      name: name.trim(),
      ...(password ? { password } : {}),
      ...(group ? { group: group.trim() } : {}),
      ...(note ? { note: note.trim() } : {}),
    }
    remotes.push(remote)
    writeRemotes(remotes)
    return NextResponse.json(remote, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
