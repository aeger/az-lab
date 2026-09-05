#!/usr/bin/env node
// mint-aip-token.mjs — mint a short-lived AIP caller-identity token.
//
// AIP tokens are attribution credentials, not admission credentials: the server
// is gated by Traefik's lan-allow@file, and an anonymous LAN caller already has
// every tool. A token buys a *trusted* source/updated_by stamp and, via the
// scope claim, a smaller blast radius if it leaks. Mint the narrowest scope the
// agent actually needs.
//
// The signing secret never leaves this host — run this here, then hand the
// agent only the resulting header file.
//
//   node mint-aip-token.mjs --sub atlas --ttl-days 30 --scope "memory:read memory:write"
//   node mint-aip-token.mjs --sub atlas --out /tmp/atlas-aip-header.txt
//
// Scopes the server enforces (everything else is advisory):
//   memory:admin  forget, forget_file, delete_skill, merge_memories,
//                 supersede_memory, discard_redundant
//   ha:control    ha_call_service
//   memory:*      wildcard, satisfies both
// Read and write are deliberately NOT enforced — gating them would be theatre.

import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && i < process.argv.length - 1 ? process.argv[i + 1] : fallback
}

// Server-side ceiling in src/index.ts (AIP_MAX_TTL_DAYS). Minting past it
// produces a token the server will reject on sight, so refuse here instead.
const MAX_TTL_DAYS = parseInt(process.env.AIP_MAX_TTL_DAYS ?? '30', 10)

const sub = arg('sub')
const ttlDays = parseFloat(arg('ttl-days', '30'))
const scope = arg('scope', 'memory:read memory:write')
const issuer = process.env.AIP_ISSUER ?? 'az-lab'
const out = arg('out')

if (!sub) {
  console.error('Usage: node mint-aip-token.mjs --sub <agent> [--ttl-days N] [--scope "a b"] [--out header-file]')
  process.exit(1)
}
if (!(ttlDays > 0) || ttlDays > MAX_TTL_DAYS) {
  console.error(`--ttl-days must be >0 and <=${MAX_TTL_DAYS} (the server's AIP_MAX_TTL_DAYS ceiling); got ${ttlDays}`)
  process.exit(1)
}

// Read the secret from .env rather than the environment so this works from a
// bare shell, and so the secret is never echoed into shell history.
const envPath = resolve(HERE, '.env')
let secret = process.env.AIP_SECRET
if (!secret) {
  const line = readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => l.startsWith('AIP_SECRET='))
  if (!line) {
    console.error(`AIP_SECRET not set and not found in ${envPath}`)
    process.exit(1)
  }
  secret = line.slice('AIP_SECRET='.length).trim().replace(/^["']|["']$/g, '')
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const iat = Math.floor(Date.now() / 1000)
const exp = iat + Math.round(ttlDays * 86400)

const signingInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iss: issuer, iat, exp, scope })}`
const token = `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`

if (out) {
  const path = resolve(out)
  // 0600 before the write would race; write then clamp, and accept that the
  // file is briefly umask-wide. On Windows the ACL has to be set separately —
  // see docs/aip-tokens.md.
  writeFileSync(path, `Authorization: Bearer ${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log(`Wrote header file (0600): ${path}`)
} else {
  console.log(token)
}

console.error(`  sub=${sub} iss=${issuer} scope="${scope}"`)
console.error(`  issued ${new Date(iat * 1000).toISOString()}  expires ${new Date(exp * 1000).toISOString()} (${ttlDays}d)`)
