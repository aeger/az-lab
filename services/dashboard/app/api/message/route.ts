import { NextRequest, NextResponse } from 'next/server'
import { readMessage, writeMessage } from '@/lib/message'

export async function GET() {
  const msg = readMessage()
  return NextResponse.json(msg)
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET ?? 'changeme'
  const auth = req.headers.get('authorization') ?? ''

  if (auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const updated = writeMessage(body)
    return NextResponse.json(updated)
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
}
