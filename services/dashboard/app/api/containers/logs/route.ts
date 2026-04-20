import { NextRequest, NextResponse } from 'next/server'
import { sshExec } from '@/lib/ssh-exec'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export async function GET(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const name = req.nextUrl.searchParams.get('name')
  const tail = req.nextUrl.searchParams.get('tail') ?? '100'

  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ error: 'Invalid container name' }, { status: 400 })
  }

  const tailNum = Math.min(500, Math.max(10, parseInt(tail, 10) || 100))

  try {
    const output = await sshExec(`podman logs --tail ${tailNum} --timestamps ${name} 2>&1`, 15_000)
    return NextResponse.json({ logs: output, name })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Failed to fetch logs: ${msg}` }, { status: 500 })
  }
}
