import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { RustDeskRemote } from '../route'

const DATA_FILE = join(process.cwd(), 'data', 'rustdesk_remotes.json')

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

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  try {
    const body = await req.json()
    const { peerId, name, password, group, note } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const remotes = readRemotes()
    const idx = remotes.findIndex((r) => r.id === id)
    if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const updated: RustDeskRemote = {
      ...remotes[idx],
      name: name.trim(),
      ...(peerId && typeof peerId === 'string' ? { peerId: peerId.trim() } : {}),
      ...(password ? { password } : {}),
      ...(group ? { group: group.trim() } : {}),
      ...(note ? { note: note.trim() } : {}),
    }
    if (!password) delete updated.password
    if (!group) delete updated.group
    if (!note) delete updated.note
    remotes[idx] = updated
    writeRemotes(remotes)
    return NextResponse.json(updated)
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const remotes = readRemotes()
  const idx = remotes.findIndex((r) => r.id === id)
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  remotes.splice(idx, 1)
  writeRemotes(remotes)
  return NextResponse.json({ success: true })
}
