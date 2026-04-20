import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

const UPDATES_FILE = join(process.cwd(), 'data', 'updates.json')

export async function GET() {
  try {
    const raw = readFileSync(UPDATES_FILE, 'utf-8')
    const data = JSON.parse(raw)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ containers: [], checked_at: null })
  }
}
