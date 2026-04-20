import { NextRequest, NextResponse } from 'next/server'
import type { Goal } from '@/app/api/goals/route'

const PRIORITY_LABELS: Record<number, string> = { 0: 'CRITICAL', 1: 'HIGH', 2: 'MEDIUM', 3: 'LOW' }

function toMarkdown(g: Goal): string {
  const lines = [
    `# Goal: ${g.title}`,
    ``,
    `**ID:** \`${g.id}\`  **Level:** ${g.level}  **Status:** ${g.status}`,
    `**Priority:** ${PRIORITY_LABELS[g.priority] ?? g.priority}  **Progress:** ${g.progress}%`,
    g.target_date ? `**Target Date:** ${g.target_date}` : '',
    ``,
  ].filter(Boolean)
  if (g.description) lines.push(`## Description`, ``, g.description, ``)
  if (g.notes) lines.push(`## Notes`, ``, g.notes, ``)
  if (g.tags?.length) lines.push(`## Tags`, ``, g.tags.join(', '), ``)
  lines.push(`---`, `Exported: ${new Date().toISOString()}`)
  return lines.join('\n')
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })

  const { id } = await params
  const format = req.nextUrl.searchParams.get('format') ?? 'json'

  const fetchRes = await fetch(
    `${url}/rest/v1/goals?id=eq.${id}&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch goal' }, { status: 500 })
  const rows: Goal[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Goal not found' }, { status: 404 })

  const goal = rows[0]
  const filename = `goal-${id.slice(0, 8)}`

  if (format === 'md' || format === 'markdown') {
    return new NextResponse(toMarkdown(goal), {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="${filename}.md"`,
      },
    })
  }

  return new NextResponse(JSON.stringify(goal, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}.json"`,
    },
  })
}
