import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie') || ''
  if (!cookie.includes('authelia_session')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      '/usr/bin/python3',
      ['/home/almty1/claude/tools/infra/security_scan.py'],
      { timeout: 60_000 }
    )
    return NextResponse.json({ success: true, output: stdout + stderr })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `Scan failed: ${msg}` }, { status: 500 })
  }
}
