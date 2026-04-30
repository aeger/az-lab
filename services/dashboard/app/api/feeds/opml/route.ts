import { NextRequest, NextResponse } from 'next/server'
import { getFeeds } from '@/lib/feeds'

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildOpml(type: 'lab' | 'family'): string {
  const feeds = getFeeds(type)
  const label = type === 'lab' ? 'Tech / Lab' : 'Family'
  const outlines = feeds
    .map(
      (f) =>
        `      <outline type="rss" text="${escXml(f.name)}" title="${escXml(f.name)}" xmlUrl="${escXml(f.url)}"/>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>AZ-Lab ${escXml(label)} Feeds</title>
  </head>
  <body>
    <outline text="${escXml(label)}">
${outlines}
    </outline>
  </body>
</opml>`
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('type')
  const type: 'lab' | 'family' = raw === 'family' ? 'family' : 'lab'
  const xml = buildOpml(type)
  const filename = `az-lab-${type}-feeds.opml`
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
