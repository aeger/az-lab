'use client'

import { useEffect, useState } from 'react'

interface Photo {
  id: string
  url: string
}

interface PhotoSlideshowProps {
  intervalSeconds: number
}

export default function PhotoSlideshow({ intervalSeconds }: PhotoSlideshowProps) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [current, setCurrent] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/photos')
      .then((r) => r.json())
      .then((d) => setPhotos(d.photos ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (photos.length === 0) return
    const interval = setInterval(() => {
      setCurrent((prev) => (prev + 1) % photos.length)
    }, intervalSeconds * 1000)
    return () => clearInterval(interval)
  }, [photos, intervalSeconds])

  if (photos.length === 0) {
    return (
      <div className="h-full rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900 flex items-center justify-center">
        <div className="text-center text-zinc-500">
          <div className="text-4xl mb-2">📷</div>
          <div className="text-sm">Photos not configured</div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full rounded-xl overflow-hidden bg-zinc-900">
      {photos.map((photo, i) => (
        <img
          key={photo.id}
          src={photo.url}
          alt=""
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ${i === current ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => i === 0 && setLoaded(true)}
        />
      ))}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      )}
      <div className="absolute bottom-2 right-2 flex gap-1">
        {photos.map((_, i) => (
          <button
            key={i}
            onClick={() => setCurrent(i)}
            className={`w-1.5 h-1.5 rounded-full transition-colors ${i === current ? 'bg-white' : 'bg-white/30'}`}
          />
        ))}
      </div>
    </div>
  )
}
