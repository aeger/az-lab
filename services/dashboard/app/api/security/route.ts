import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

const SECURITY_FILE = join(process.cwd(), 'data', 'security.json')

export async function GET() {
  if (!existsSync(SECURITY_FILE)) {
    return NextResponse.json({ error: 'no_data' }, { status: 404 })
  }
  try {
    const data = JSON.parse(readFileSync(SECURITY_FILE, 'utf-8'))
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 500 })
  }
}
