import { NextResponse } from 'next/server'
import { fetchRandomPhotos } from '@/lib/immich'

export async function GET() {
  try {
    const photos = await fetchRandomPhotos(20)
    return NextResponse.json({ photos })
  } catch {
    return NextResponse.json({ photos: [] })
  }
}
