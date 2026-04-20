import { NextResponse } from 'next/server'
import { fetchContainers } from '@/lib/portainer'

export async function GET() {
  try {
    const containers = await fetchContainers()
    return NextResponse.json({ containers })
  } catch {
    return NextResponse.json({ containers: [] })
  }
}
