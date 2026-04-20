import { NextRequest, NextResponse } from 'next/server'
import { getAllQuickLinks, saveQuickLinks } from '@/lib/quicklinks'
import type { QuickLink } from '@/lib/config'

export async function GET() {
  return NextResponse.json(getAllQuickLinks())
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET
  const auth = req.headers.get('authorization')
  if (!adminSecret || auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { section, links } = (await req.json()) as { section: 'home' | 'lab'; links: QuickLink[] }
    if (section !== 'home' && section !== 'lab') {
      return NextResponse.json({ error: 'Invalid section — must be "home" or "lab"' }, { status: 400 })
    }
    if (!Array.isArray(links)) {
      return NextResponse.json({ error: 'links must be an array' }, { status: 400 })
    }
    saveQuickLinks(section, links)
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
