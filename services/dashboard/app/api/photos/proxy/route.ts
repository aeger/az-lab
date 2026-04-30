import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  const baseUrl = process.env.IMMICH_URL
  const apiKey = process.env.IMMICH_API_KEY

  if (!id || !baseUrl || !apiKey) {
    return new NextResponse(null, { status: 404 })
  }

  try {
    const res = await fetch(`${baseUrl}/api/assets/${id}/thumbnail?size=preview`, {
      headers: { 'x-api-key': apiKey },
    })

    if (!res.ok) return new NextResponse(null, { status: res.status })

    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const buffer = await res.arrayBuffer()

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }
}
