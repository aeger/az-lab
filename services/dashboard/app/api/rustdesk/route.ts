import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import net from 'net'

const DEVICES_FILE = join(process.cwd(), 'data', 'rustdesk-devices.json')

interface RustDeskDevice {
  id: string
  name: string
  icon?: string
}

async function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
    socket.on('error', () => resolve(false))
    socket.connect(port, host)
  })
}

function loadDevices(): RustDeskDevice[] {
  if (!existsSync(DEVICES_FILE)) return []
  try {
    return JSON.parse(readFileSync(DEVICES_FILE, 'utf-8'))
  } catch {
    return []
  }
}

export async function GET() {
  const host = process.env.RUSTDESK_HOST
  const key = process.env.RUSTDESK_KEY ?? ''

  if (!host) {
    return NextResponse.json({ configured: false })
  }

  const [hbbs, hbbr] = await Promise.all([
    tcpProbe(host, 21116),
    tcpProbe(host, 21117),
  ])

  const devices = loadDevices()

  return NextResponse.json({ configured: true, hbbs, hbbr, host, key, devices })
}
