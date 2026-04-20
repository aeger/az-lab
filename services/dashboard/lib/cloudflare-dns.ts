const CF_API = 'https://api.cloudflare.com/client/v4'
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '3a544823ed668505980fa792464726b5'
const API_TOKEN = process.env.CLOUDFLARE_DNS_API_TOKEN

function headers() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

export interface DnsRecord {
  id: string
  name: string
  type: string
  content: string
}

export async function findDnsRecord(hostname: string): Promise<DnsRecord | null> {
  if (!API_TOKEN) return null
  const res = await fetch(
    `${CF_API}/zones/${ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(hostname)}`,
    { headers: headers() }
  )
  const data = await res.json()
  if (!data.success || !data.result?.length) return null
  return data.result[0] as DnsRecord
}

export async function createDnsRecord(hostname: string, ip: string): Promise<DnsRecord | null> {
  if (!API_TOKEN) return null
  const res = await fetch(`${CF_API}/zones/${ZONE_ID}/dns_records`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ type: 'A', name: hostname, content: ip, ttl: 1, proxied: false }),
  })
  const data = await res.json()
  if (!data.success) return null
  return data.result as DnsRecord
}

export async function deleteDnsRecord(hostname: string): Promise<boolean> {
  if (!API_TOKEN) return false
  const record = await findDnsRecord(hostname)
  if (!record) return false
  const res = await fetch(`${CF_API}/zones/${ZONE_ID}/dns_records/${record.id}`, {
    method: 'DELETE',
    headers: headers(),
  })
  const data = await res.json()
  return data.success === true
}

export async function upsertDnsRecord(hostname: string, ip: string): Promise<boolean> {
  if (!API_TOKEN) return false
  const existing = await findDnsRecord(hostname)
  if (existing) {
    // Update if IP changed
    if (existing.content === ip) return true
    const res = await fetch(`${CF_API}/zones/${ZONE_ID}/dns_records/${existing.id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ content: ip }),
    })
    const data = await res.json()
    return data.success === true
  }
  const created = await createDnsRecord(hostname, ip)
  return created !== null
}
