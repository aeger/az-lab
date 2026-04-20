import { NextRequest, NextResponse } from 'next/server'
import type { TaskItem } from '@/app/api/taskqueue/route'

const SUPA_HEADERS = (key: string) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
})

const PRIORITY_LABELS: Record<number, string> = { 0: 'CRITICAL', 1: 'HIGH', 2: 'MEDIUM', 3: 'LOW' }

function toMarkdown(t: TaskItem): string {
  const ctx = (t.context ?? {}) as Record<string, unknown>
  const checklist = Array.isArray(ctx.checklist) ? ctx.checklist as Array<{ text: string; done: boolean }> : []
  const lines = [
    `# Task: ${t.title}`,
    ``,
    `**ID:** \`${t.id}\`  **Status:** ${t.status}  **Priority:** ${PRIORITY_LABELS[t.priority] ?? t.priority}`,
    `**Created:** ${t.created_at}  **Updated:** ${t.updated_at}`,
    `**Source:** ${t.source ?? '—'} → **Target:** ${t.target ?? '—'}`,
    ``,
  ]
  if (t.description) lines.push(`## Description`, ``, t.description, ``)
  if (ctx.context_summary) lines.push(`## Context Summary`, ``, String(ctx.context_summary), ``)
  if (checklist.length) {
    lines.push(`## Checklist`, ``)
    for (const item of checklist) {
      lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`)
    }
    lines.push(``)
  }
  if (ctx.jeff_notes) lines.push(`## Jeff Notes`, ``, String(ctx.jeff_notes), ``)
  if (t.result) lines.push(`## Result`, ``, t.result, ``)
  if (t.error) lines.push(`## Error`, ``, t.error, ``)
  if (t.tags?.length) lines.push(`## Tags`, ``, t.tags.join(', '), ``)
  return lines.join('\n')
}

function toCsv(t: TaskItem): string {
  const header = 'id,title,status,priority,source,target,created_at,updated_at,tags'
  const row = [
    t.id, t.title, t.status, PRIORITY_LABELS[t.priority] ?? t.priority,
    t.source ?? '', t.target ?? '', t.created_at, t.updated_at,
    (t.tags ?? []).join(';'),
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  return `${header}\n${row}`
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
    `${url}/rest/v1/task_queue?id=eq.${id}&select=*`,
    { headers: SUPA_HEADERS(key), cache: 'no-store' }
  )
  if (!fetchRes.ok) return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 })
  const rows: TaskItem[] = await fetchRes.json()
  if (!rows.length) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const task = rows[0]
  const filename = `task-${id.slice(0, 8)}`

  if (format === 'md' || format === 'markdown') {
    return new NextResponse(toMarkdown(task), {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="${filename}.md"`,
      },
    })
  }

  if (format === 'csv') {
    return new NextResponse(toCsv(task), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    })
  }

  // JSON (default)
  return new NextResponse(JSON.stringify(task, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}.json"`,
    },
  })
}
