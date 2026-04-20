export interface ImmichPhoto {
  id: string
  url: string
}

export async function fetchRandomPhotos(count = 20): Promise<ImmichPhoto[]> {
  const baseUrl = process.env.IMMICH_URL
  const apiKey = process.env.IMMICH_API_KEY

  if (!baseUrl || !apiKey) return []

  try {
    const res = await fetch(`${baseUrl}/api/search/random`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ count }),
    })

    if (!res.ok) return []

    const assets = await res.json()

    return (assets as { id: string; type: string }[])
      .filter((a) => a.type === 'IMAGE')
      .map((asset) => ({
        id: asset.id,
        url: `/api/photos/proxy?id=${asset.id}`,
      }))
  } catch {
    return []
  }
}
