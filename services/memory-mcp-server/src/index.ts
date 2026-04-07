import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import express, { Request, Response } from "express";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3100", 10);
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_KEY;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "az-lab-memory";

const HA_URL = process.env.HA_URL || "";
const HA_TOKEN = process.env.HA_TOKEN || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Security Scanner ─────────────────────────────────────────────────────────
const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
  [/pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|new|another)/i, "persona_hijack"],
  [/your\s+(new\s+)?(instructions?|rules?|directives?)\s+are/i, "instruction_override"],
  [/\u200b|\u200c|\u200d|\u2060|\ufeff|[\u202a-\u202e]/, "invisible_unicode"],
];

function scanContent(text: string): string | null {
  for (const [pattern, threatId] of THREAT_PATTERNS) {
    if (pattern.test(text)) return threatId;
  }
  return null;
}

// ── Conflict Detection ────────────────────────────────────────────────────────
// Simple heuristic: look for negation words near shared nouns between two memory contents
const NEGATION_PATTERNS = [
  /\b(not|no|never|don'?t|cannot|can'?t|won'?t|isn'?t|aren'?t|wasn'?t|weren'?t|disabled?|removed?|deprecated?|replaced?)\b/i,
  /\b(changed?|updated?|no longer|instead of|replaced? with|switched? to)\b/i,
];

function mightContradict(contentA: string, contentB: string): boolean {
  const hasNegationA = NEGATION_PATTERNS.some((p) => p.test(contentA));
  const hasNegationB = NEGATION_PATTERNS.some((p) => p.test(contentB));
  if (!hasNegationA && !hasNegationB) return false;

  // Extract key nouns (words >4 chars, not stopwords) and check overlap
  const stopwords = new Set(["this","that","with","from","have","will","been","they","their","there","about","which","these","those","would","could","should","after","before"]);
  const words = (text: string) => text.toLowerCase().match(/\b[a-z]{4,}\b/g)?.filter((w) => !stopwords.has(w)) ?? [];
  const wordsA = new Set(words(contentA));
  const wordsB = words(contentB);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;

  return overlap >= 3; // Significant topic overlap + negation = possible contradiction
}

async function detectConflicts(
  newMemoryId: string,
  newContent: string,
  type: string,
  tags: string[],
  embedding: number[] | null
): Promise<string | null> {
  // Find candidates: same type, overlapping tags, high similarity
  let candidates: Array<{ id: string; name: string; content: string }> = [];

  if (embedding) {
    const { data } = await supabase.rpc("match_memories", {
      query_embedding: JSON.stringify(embedding),
      match_threshold: 0.72,
      match_count: 8,
    });
    if (data) {
      candidates = (data as any[])
        .filter((m) => m.id !== newMemoryId && m.type === type)
        .map((m) => ({ id: m.id, name: m.name, content: m.content }));
    }
  }

  const conflictNames: string[] = [];
  for (const candidate of candidates) {
    if (mightContradict(newContent, candidate.content)) {
      // Record contradiction conflict
      await supabase.from("memory_conflicts").upsert({
        memory_a_id: newMemoryId,
        memory_b_id: candidate.id,
        conflict_type: "contradiction",
        description: `New memory may contradict "${candidate.name}"`,
        resolved: false,
      }, { onConflict: "memory_a_id,memory_b_id" });
      // Also record stale conflict against the older memory (new supersedes old)
      await supabase.from("memory_conflicts").upsert({
        memory_a_id: candidate.id,
        memory_b_id: newMemoryId,
        conflict_type: "stale",
        description: `May be superseded by newer memory "${newContent.slice(0, 80)}..."`,
        resolved: false,
      }, { onConflict: "memory_a_id,memory_b_id" });
      // Flag both memories
      await supabase.from("memories").update({ conflict_flagged: true }).in("id", [newMemoryId, candidate.id]);
      conflictNames.push(candidate.name);
    }
  }

  return conflictNames.length > 0 ? conflictNames.join(", ") : null;
}

// ── Mem0 Conflict Resolution ──────────────────────────────────────────────────
// Based on arXiv 2504.19413 — classify every write as ADD/UPDATE/DELETE/NOOP
// to prevent stale/duplicate memory accumulation.
// Heuristic mode (default): fast, no LLM required.
// LLM mode: set LLM_URL to any OpenAI-compatible endpoint (e.g. NemoClaw NIM API).

const LLM_URL = process.env.LLM_URL || "";
const LLM_MODEL = process.env.LLM_MODEL || "llama3.2:3b";

// Nemotron reranking — set NVIDIA_API_KEY to enable
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const RERANK_URL = process.env.RERANK_URL || "http://192.168.1.183:8000";
const RERANK_MODEL = process.env.RERANK_MODEL || "nvidia/nemotron-3-super-120b-a12b";
const RERANK_TOP_K = parseInt(process.env.RERANK_TOP_K || "5", 10);

type Mem0Action = "ADD" | "UPDATE" | "DELETE" | "NOOP";

interface Mem0Decision {
  action: Mem0Action;
  target_id?: string;
  target_name?: string;
  rationale: string;
}

// Jaccard similarity on word tokens (fast, no embedding required)
function textSimilarity(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/\b\w{3,}\b/g) || []);
  const A = words(a);
  const B = words(b);
  const intersection = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 1 : intersection / union;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Heuristic Mem0 classification (no LLM needed)
function heuristicMem0(
  newName: string,
  newContent: string,
  candidates: Array<{ id: string; name: string; content: string; similarity: number }>
): Mem0Decision[] {
  const decisions: Mem0Decision[] = [];

  for (const c of candidates) {
    const sim = c.similarity;

    // Near-identical content → NOOP (highest priority, return immediately)
    if (sim >= 0.95 && textSimilarity(newContent, c.content) >= 0.80) {
      return [{ action: "NOOP", target_id: c.id, target_name: c.name,
        rationale: `Already captured in "${c.name}" (${(sim * 100).toFixed(0)}% similar)` }];
    }

    const nameSimilar = levenshtein(c.name.toLowerCase(), newName.toLowerCase()) <= 3;
    const contradicts = mightContradict(newContent, c.content);

    if (contradicts && sim >= 0.72) {
      // Contradicted/stale → DELETE the old one; new content will be ADDed after
      decisions.push({ action: "DELETE", target_id: c.id, target_name: c.name,
        rationale: `Contradicts stale memory "${c.name}" (sim=${(sim * 100).toFixed(0)}%)` });
    } else if (sim >= 0.88 && nameSimilar && !contradicts) {
      // High similarity + similar name → UPDATE in place (prevents cross-name duplicates)
      decisions.push({ action: "UPDATE", target_id: c.id, target_name: c.name,
        rationale: `Updates existing memory "${c.name}" (sim=${(sim * 100).toFixed(0)}%)` });
    }
  }

  if (decisions.length === 0) {
    decisions.push({ action: "ADD", rationale: "No conflicts with existing memories" });
  }
  return decisions;
}

// LLM-based Mem0 classification (falls back to heuristic on any failure)
async function llmMem0(
  newName: string,
  newContent: string,
  candidates: Array<{ id: string; name: string; content: string; similarity: number }>
): Promise<Mem0Decision[]> {
  const prompt = `You are a memory deduplication system. Given a new fact and existing similar memories, classify the required operation.

New memory:
Name: ${newName}
Content: ${newContent.slice(0, 800)}

Existing similar memories:
${candidates.slice(0, 5).map((c, i) =>
  `[${i + 1}] id=${c.id}\nname=${c.name}\ncontent=${c.content.slice(0, 400)}`
).join("\n\n---\n")}

Classify the operation required:
- NOOP: New memory is fully captured by an existing one. No write needed.
- UPDATE: New memory updates/corrects an existing one. Merge content into it.
- DELETE: An existing memory is contradicted/stale. Remove it (new fact added separately).
- ADD: Genuinely new fact with no significant overlap.

Rules: NOOP only if content is essentially identical. Multiple DELETE decisions allowed. Prefer UPDATE over ADD when clearly the same topic. Respond with a JSON array only, no explanation outside JSON.

Example: [{"action":"DELETE","target_id":"abc-123","target_name":"old fact","rationale":"contradicted by new IP"}]`;

  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as any;
    let raw = json.choices?.[0]?.message?.content?.trim() || "[]";
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    let parsed: Mem0Decision[] = JSON.parse(raw);
    if (!Array.isArray(parsed)) parsed = [parsed];
    const valid = parsed.filter((d) => ["ADD", "UPDATE", "DELETE", "NOOP"].includes(d.action));
    return valid.length > 0 ? valid : [{ action: "ADD", rationale: "LLM returned no valid decisions" }];
  } catch (err: any) {
    console.warn("[mem0] LLM classify failed:", err.message, "— heuristic fallback");
    return heuristicMem0(newName, newContent, candidates);
  }
}

// Entry point: fetch candidates then classify
async function mem0Resolve(
  name: string,
  content: string,
  type: string,
  embedding: number[],
  excludeId?: string
): Promise<Mem0Decision[]> {
  const { data: raw } = await supabase.rpc("match_memories", {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.72,
    match_count: 10,
  });

  if (!raw?.length) return [{ action: "ADD", rationale: "No similar memories found" }];

  const candidates = (raw as any[])
    .filter((m) => m.id !== excludeId && m.type === type)
    .map((m) => ({ id: m.id, name: m.name, content: m.content, similarity: m.similarity as number }))
    .slice(0, 8);

  if (!candidates.length) return [{ action: "ADD", rationale: "No same-type candidates" }];

  return LLM_URL
    ? llmMem0(name, content, candidates)
    : heuristicMem0(name, content, candidates);
}

// ── Embeddings ───────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { embedding: number[] };
    return json.embedding;
  } catch {
    return null; // Ollama unavailable — degrade gracefully
  }
}

function embedInput(name: string, description: string, content: string): string {
  return `${name}: ${description}\n\n${content}`.slice(0, 4000);
}

// ── Nemotron Reranking ────────────────────────────────────────────────────────
// Retrieves top-20 from hybrid recall, then asks Nemotron 120B to reorder by
// relevance, returning top RERANK_TOP_K. Falls back to original order on failure.
async function rerankMemories(query: string, memories: any[]): Promise<any[]> {
  if (!NVIDIA_API_KEY || memories.length <= 1) return memories;

  const snippets = memories.map((m, i) =>
    `[${i}] ${m.name} (${m.type}): ${m.description}\n${(m.content || "").slice(0, 250)}`
  ).join("\n\n");

  const prompt = `You are a memory relevance ranker. Given the search query and candidate memories, return a JSON array of candidate indices ordered from most to least relevant to the query. Include all indices.

Query: "${query}"

Candidates:
${snippets}

Respond with only a JSON array of indices, e.g.: [2, 0, 4, 1, 3]`;

  try {
    const res = await fetch(`${RERANK_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${NVIDIA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RERANK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Rerank HTTP ${res.status}`);
    const json = await res.json() as any;
    let raw = (json.choices?.[0]?.message?.content || "").trim();
    raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const indices: number[] = JSON.parse(raw);
    if (!Array.isArray(indices)) throw new Error("Non-array response");
    const seen = new Set<number>();
    const reranked: any[] = [];
    for (const i of indices) {
      if (typeof i === "number" && i >= 0 && i < memories.length && !seen.has(i)) {
        reranked.push(memories[i]);
        seen.add(i);
      }
    }
    // Append any memories not mentioned by Nemotron
    for (let i = 0; i < memories.length; i++) {
      if (!seen.has(i)) reranked.push(memories[i]);
    }
    console.log(`[rerank] Nemotron reranked ${memories.length} memories`);
    return reranked;
  } catch (err: any) {
    console.warn("[rerank] Nemotron rerank failed:", err.message, "— original order preserved");
    return memories;
  }
}

// R2 client (optional — file tools disabled if not configured)
const r2Enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const r2 = r2Enabled
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ── Source trust levels ───────────────────────────────────────────────────────
const SOURCE_TRUST: Record<string, string> = {
  "claude-code": "high",
  "claude-ai": "medium",
  "manual": "verified",
};

// ── Startup Migration ────────────────────────────────────────────────────────
// Attempts to add link_type column to memory_links via the pre-registered
// add_link_type_if_missing() SECURITY DEFINER function.
// If the function doesn't exist yet, this is a no-op — apply migrations/001_add_link_type.sql
// via the Supabase SQL editor to bootstrap.
async function applyStartupMigrations(): Promise<void> {
  // Migration 001: link_type column on memory_links
  try {
    const { data, error } = await supabase.rpc("add_link_type_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 001 RPC not yet registered — apply migrations/001_add_link_type.sql in Supabase SQL editor.");
      } else {
        console.warn("Migration 001 warning:", error.message);
      }
    } else {
      console.log("Migration 001 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 001 skipped:", err.message);
  }

  // Migration 003: adaptive decay columns (last_accessed_at, importance_score)
  try {
    const { data, error } = await supabase.rpc("apply_adaptive_decay_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 003 RPC not yet registered — apply migrations/003_adaptive_decay.sql in Supabase SQL editor to enable adaptive decay.");
      } else {
        console.warn("Migration 003 warning:", error.message);
      }
    } else {
      console.log("Migration 003 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 003 skipped:", err.message);
  }

  // Migration 004: PageRank scoring over Zettelkasten memory link graph
  try {
    const { data, error } = await supabase.rpc("apply_pagerank_migration_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 004 RPC not yet registered — apply migrations/004_pagerank.sql in Supabase SQL editor to enable PageRank scoring.");
      } else {
        console.warn("Migration 004 warning:", error.message);
      }
    } else {
      console.log("Migration 004 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 004 skipped:", err.message);
  }

  // Migration 005: Add 'duplicate' to memory_conflicts conflict_type check constraint
  try {
    const { data, error } = await supabase.rpc("apply_duplicate_conflict_type_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 005 RPC not yet registered — apply migrations/005_add_duplicate_conflict_type.sql in Supabase SQL editor.");
      } else {
        console.warn("Migration 005 warning:", error.message);
      }
    } else {
      console.log("Migration 005 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 005 skipped:", err.message);
  }

  // Migration 007: BM25 search_vector GENERATED ALWAYS + updated hybrid_recall
  try {
    const { data, error } = await supabase.rpc("apply_bm25_migration_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 007 RPC not yet registered — apply migrations/007_bm25_generated_vector.sql in Supabase SQL editor.");
      } else {
        console.warn("Migration 007 warning:", error.message);
      }
    } else {
      console.log("Migration 007 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 007 skipped:", err.message);
  }

  // Migration 008: Switch BM25 path from search_vector to search_vec (weighted: name=A, desc=B, content=C)
  try {
    const { data, error } = await supabase.rpc("apply_search_vec_migration_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 008 RPC not yet registered — apply migrations/008_switch_bm25_to_search_vec.sql in Supabase SQL editor.");
      } else {
        console.warn("Migration 008 warning:", error.message);
      }
    } else {
      console.log("Migration 008 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 008 skipped:", err.message);
  }

  // Migration 009: Trigram fallback for zero-BM25-hit queries (code identifiers with underscores)
  try {
    const { data, error } = await supabase.rpc("apply_trigram_fallback_if_missing");
    if (error) {
      if (error.message?.includes("PGRST202") || error.code === "PGRST202" ||
          error.message?.includes("not found in the schema cache")) {
        console.log("Migration 009 RPC not yet registered — apply migrations/009_trigram_fallback.sql in Supabase SQL editor.");
      } else {
        console.warn("Migration 009 warning:", error.message);
      }
    } else {
      console.log("Migration 009 result:", data);
    }
  } catch (err: any) {
    console.warn("Migration 009 skipped:", err.message);
  }
}

// ── MCP Server Factory ───────────────────────────────────────────────────────
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "memory-mcp-server",
    version: "4.2.0",
  });

  // ── Tool: remember ──────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store a new memory or update an existing one. Use this when you learn something worth keeping.",
    {
      type: z.enum(["user", "feedback", "project", "reference"]).describe(
        "Memory type: user (about the user), feedback (how to work), project (ongoing work), reference (where to find things)"
      ),
      name: z.string().describe("Short, unique name for this memory"),
      description: z.string().describe("One-line description — used to decide relevance later"),
      content: z.string().describe("Full memory content. For feedback/project types, include Why and How to apply."),
      tags: z.array(z.string()).optional().describe("Tags for categorization and search"),
      source: z.string().optional().describe("Who is writing: claude-code, claude-ai, manual"),
      importance_score: z.number().min(0).max(1).optional().describe("Importance 0-1 (default 0.5). Higher = decays slower and ranks higher in recall. Use 0.8+ for critical long-term facts, 0.2 for ephemeral context."),
    },
    async ({ type, name, description, content, tags, source, importance_score }) => {
      // Security gate — scan all text fields before touching the DB
      const scanTargets: Array<[string, string]> = [
        ["name", name], ["description", description], ["content", content],
      ];
      for (const [field, value] of scanTargets) {
        const threat = scanContent(value);
        if (threat) {
          return { content: [{ type: "text" as const, text: `Blocked: ${field} matches threat pattern '${threat}'. Memory not written.` }] };
        }
      }

      const src = source || "claude-code";
      const memTags = tags || [];

      // Fetch existing same-name memory (with content for NOOP check)
      const { data: existing } = await supabase
        .from("memories")
        .select("id, content")
        .eq("name", name)
        .maybeSingle();

      const embedding = await embed(embedInput(name, description, content));
      const embedNote = embedding ? "" : " (no embedding — Ollama unavailable)";

      // ── Same-name path ──────────────────────────────────────────────────────
      if (existing) {
        // Mem0 NOOP: content is essentially unchanged — skip write
        if (existing.content && textSimilarity(existing.content, content) >= 0.85) {
          return { content: [{ type: "text" as const, text: `NOOP: Memory "${name}" content is unchanged (Jaccard ≥ 85%). No write needed.` }] };
        }

        const update: Record<string, unknown> = { type, description, content, tags: memTags, source: src };
        if (embedding) update.embedding = JSON.stringify(embedding);
        if (importance_score !== undefined) update.importance_score = importance_score;
        const { error } = await supabase.from("memories").update(update).eq("id", existing.id);
        if (error) return { content: [{ type: "text" as const, text: `Error updating memory: ${error.message}` }] };

        // Re-link on update
        let linkNote = "";
        if (embedding) {
          await supabase.from("memory_links").delete().eq("source_id", existing.id).eq("relationship", "related_to");
          const { data: similar } = await supabase.rpc("match_memories", {
            query_embedding: JSON.stringify(embedding),
            match_threshold: 0.75,
            match_count: 5,
          });
          if (similar?.length) {
            const links = similar
              .filter((m: any) => m.id !== existing.id)
              .map((m: any) => ({ source_id: existing.id, target_id: m.id, relationship: "related_to", link_type: "semantic", strength: Math.min(m.similarity, 1.0) }));
            if (links.length) {
              await supabase.from("memory_links").upsert(links, { onConflict: "source_id,target_id,relationship" });
              linkNote = ` Re-linked to ${links.length} related memor${links.length === 1 ? "y" : "ies"}.`;
            }
          }
        }
        const updateConflicts = await detectConflicts(existing.id, content, type, memTags, embedding);
        const updateConflictNote = updateConflicts ? ` ⚠️ Possible contradiction with: ${updateConflicts}` : "";
        return { content: [{ type: "text" as const, text: `Updated memory "${name}" (${type})${embedNote}.${linkNote}${updateConflictNote}` }] };
      }

      // ── New-name path: full Mem0 conflict resolution ────────────────────────
      let mem0Note = "";
      if (embedding) {
        const decisions = await mem0Resolve(name, content, type, embedding);

        for (const d of decisions) {
          if (d.action === "NOOP") {
            console.log(`[mem0] NOOP "${name}": ${d.rationale}`);
            return { content: [{ type: "text" as const, text: `NOOP: Fact already captured in "${d.target_name}". No write needed. (${d.rationale})` }] };
          }

          if (d.action === "UPDATE" && d.target_id) {
            // Update the existing differently-named memory in place
            console.log(`[mem0] UPDATE "${d.target_name}": ${d.rationale}`);
            const upd: Record<string, unknown> = { description, content, tags: memTags, source: src };
            upd.embedding = JSON.stringify(embedding);
            if (importance_score !== undefined) upd.importance_score = importance_score;
            const { error: updErr } = await supabase.from("memories").update(upd).eq("id", d.target_id);
            if (!updErr) {
              return { content: [{ type: "text" as const, text: `mem0 UPDATE: merged "${name}" into existing memory "${d.target_name}". (${d.rationale})${embedNote}` }] };
            }
          }

          if (d.action === "DELETE" && d.target_id) {
            // Remove stale/contradicted memory before inserting the new one
            console.log(`[mem0] DELETE "${d.target_name}": ${d.rationale}`);
            await supabase.from("memory_links").delete().or(`source_id.eq.${d.target_id},target_id.eq.${d.target_id}`);
            await supabase.from("memories").delete().eq("id", d.target_id);
            mem0Note += ` Removed stale memory "${d.target_name}".`;
          }
        }
      }

      // ── INSERT new memory ───────────────────────────────────────────────────
      const insert: Record<string, unknown> = { type, name, description, content, tags: memTags, source: src };
      if (embedding) insert.embedding = JSON.stringify(embedding);
      if (importance_score !== undefined) insert.importance_score = importance_score;
      const { data: inserted, error } = await supabase.from("memories").insert(insert).select("id").single();

      if (error) return { content: [{ type: "text" as const, text: `Error creating memory: ${error.message}` }] };

      // Auto-link
      let linkNote = "";
      if (embedding && inserted?.id) {
        const { data: similar } = await supabase.rpc("match_memories", {
          query_embedding: JSON.stringify(embedding),
          match_threshold: 0.75,
          match_count: 5,
        });
        if (similar?.length) {
          const links = similar
            .filter((m: any) => m.id !== inserted.id)
            .map((m: any) => ({ source_id: inserted.id, target_id: m.id, relationship: "related_to", link_type: "semantic", strength: Math.min(m.similarity, 1.0) }));
          if (links.length) {
            await supabase.from("memory_links").upsert(links, { onConflict: "source_id,target_id,relationship" });
            linkNote = ` Linked to ${links.length} related memor${links.length === 1 ? "y" : "ies"}.`;
          }
        }
      }

      const conflicts = await detectConflicts(inserted.id, content, type, memTags, embedding);
      const conflictNote = conflicts ? ` ⚠️ Possible contradiction with: ${conflicts}` : "";

      return { content: [{ type: "text" as const, text: `Stored new ${type} memory "${name}"${embedNote}.${linkNote}${mem0Note}${conflictNote}` }] };
    }
  );

  // ── Tool: recall ────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search memories by text, tags, or type. Uses semantic vector search when Ollama is available, falls back to keyword search.",
    {
      query: z.string().optional().describe("Free-text or semantic search query"),
      type: z.enum(["user", "feedback", "project", "reference"]).optional().describe("Filter by memory type"),
      tags: z.array(z.string()).optional().describe("Filter by tags (any match)"),
      limit: z.number().optional().describe("Max results (default 10)"),
      semantic: z.boolean().optional().describe("Force semantic search (default: true when Ollama available)"),
    },
    async ({ query, type, tags, limit, semantic }) => {
      const maxResults = limit || 10;

      // Try hybrid recall (BM25 + vector RRF) when query is provided and semantic not explicitly disabled.
      // hybrid_recall with null embedding degrades gracefully to BM25-only (tsvector ts_rank),
      // ensuring BM25 is always used for text queries even when Ollama is unavailable.
      if (query && semantic !== false) {
        const queryEmbedding = await embed(query);
        const hybridMode = queryEmbedding ? "hybrid BM25+vector" : "BM25-only";
        const { data, error } = await supabase.rpc("hybrid_recall", {
          p_query_text: query,
          p_query_embedding: queryEmbedding ? JSON.stringify(queryEmbedding) : null,
          p_match_threshold: queryEmbedding ? 0.3 : 0.0,
          p_match_count: maxResults * 2, // wider pool, filter below
          p_filter_type: type || null,
        });

        if (!error && data && data.length > 0) {
          // Apply tag filters client-side
          let filtered = data as any[];
          if (tags?.length) filtered = filtered.filter((m) => tags.some((t) => m.tags?.includes(t)));
          // Nemotron reranking: reorder the wider pool before slicing to final count
          const rerankPool = filtered.slice(0, 20);
          const rerankEnabled = !!NVIDIA_API_KEY;
          if (rerankEnabled && rerankPool.length > 1) {
            const reranked = await rerankMemories(query, rerankPool);
            filtered = [...reranked, ...filtered.slice(20)];
          }
          const finalLimit = rerankEnabled ? Math.min(RERANK_TOP_K, maxResults) : maxResults;
          const hybridModeLabel = rerankEnabled ? `${hybridMode}+rerank` : hybridMode;
          filtered = filtered.slice(0, finalLimit);

          if (filtered.length > 0) {
            await Promise.all(filtered.map((m: any) => supabase.rpc("touch_memory", { memory_id: m.id })));

            // Fetch temporal/causal linked memories for all top results and apply score boost
            const filteredIds = new Set(filtered.map((m: any) => m.id));
            const boostedExtras: Map<string, { mem: any; boost: number }> = new Map();

            // For each top result, fetch its links and check for temporal/causal types
            const linkFetches = await Promise.all(
              filtered.map(async (m: any) => {
                const { data: links } = await supabase
                  .from("memory_links")
                  .select("target_id, link_type, strength")
                  .eq("source_id", m.id)
                  .in("link_type", ["temporal", "causal"]);
                return { sourceId: m.id, links: links || [] };
              })
            );

            // Collect unique target IDs for temporal/causal links not already in results
            const tcTargetIds: string[] = [];
            for (const { links } of linkFetches) {
              for (const link of links) {
                if (!filteredIds.has(link.target_id) && !tcTargetIds.includes(link.target_id)) {
                  tcTargetIds.push(link.target_id);
                }
              }
            }

            // Fetch those extra memories and assign boosted scores
            if (tcTargetIds.length > 0) {
              const { data: extraMems } = await supabase
                .from("memories")
                .select("id, type, name, description, content, tags, source, conflict_flagged")
                .in("id", tcTargetIds);
              if (extraMems) {
                for (const em of extraMems) {
                  // Find max boost from any temporal/causal link pointing to this memory
                  let maxBoost = 0;
                  for (const { links } of linkFetches) {
                    const link = links.find((l: any) => l.target_id === em.id);
                    if (link) maxBoost = Math.max(maxBoost, 0.1 * (link.strength || 1.0));
                  }
                  boostedExtras.set(em.id, {
                    mem: { ...em, hybrid_score: (filtered[filtered.length - 1]?.hybrid_score || 0.5) + maxBoost },
                    boost: maxBoost,
                  });
                }
              }
            }

            // Fetch links for the top result to show in the link section
            let linkSection = "";
            const top = filtered[0];
            const { data: linked } = await supabase.rpc("get_linked_memories", { memory_id: top.id, max_depth: 1 });
            if (linked?.length) {
              // Fetch link_type for each linked memory from memory_links
              const { data: linkTypeRows } = await supabase
                .from("memory_links")
                .select("target_id, link_type")
                .eq("source_id", top.id)
                .in("target_id", linked.map((l: any) => l.id));
              const linkTypeMap: Record<string, string> = {};
              for (const lt of (linkTypeRows || [])) {
                linkTypeMap[lt.target_id] = lt.link_type || "semantic";
              }
              const linkLines = linked.map((l: any) => {
                const lt = linkTypeMap[l.id] || "semantic";
                return `  - **${l.name}** (${l.relationship}, type:${lt}, strength ${l.strength.toFixed(2)}): ${l.description}`;
              });
              linkSection = `\n\n**Linked memories (${linked.length}):**\n${linkLines.join("\n")}`;
            }

            const results = filtered.map((m: any, i: number) => {
              const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
              const scoreStr = m.hybrid_score ? ` (score ${(m.hybrid_score * 100).toFixed(0)}%)` : "";
              const importanceStr = m.importance_score !== undefined && m.importance_score !== 0.5 ? ` imp:${m.importance_score.toFixed(2)}` : "";
              const accessStr = m.access_count > 0 ? ` accessed:${m.access_count}x` : "";
              const trust = SOURCE_TRUST[m.source] ? ` · trust:${SOURCE_TRUST[m.source]}` : "";
              const conflictFlag = m.conflict_flagged ? " ⚠️" : "";
              return `## ${m.name} (${m.type})${tagStr}${scoreStr}${importanceStr}${accessStr}${trust}${conflictFlag}\n_${m.description}_\n\n${m.content}${i === 0 ? linkSection : ""}`;
            });

            // Append temporal/causal boosted extras not already in results
            for (const { mem, boost } of boostedExtras.values()) {
              const tagStr = mem.tags?.length ? ` [${mem.tags.join(", ")}]` : "";
              const scoreStr = ` (score ${((mem.hybrid_score || 0) * 100).toFixed(0)}% +boost:${(boost * 100).toFixed(0)}%)`;
              const trust = SOURCE_TRUST[mem.source] ? ` · trust:${SOURCE_TRUST[mem.source]}` : "";
              const conflictFlag = mem.conflict_flagged ? " ⚠️" : "";
              results.push(`## ${mem.name} (${mem.type})${tagStr}${scoreStr}${trust}${conflictFlag} [temporal/causal link]\n_${mem.description}_\n\n${mem.content}`);
            }

            const totalCount = filtered.length + boostedExtras.size;
            const boostNote = boostedExtras.size > 0 ? ` (${boostedExtras.size} added via temporal/causal links)` : "";
            return {
              content: [{ type: "text" as const, text: `Found ${totalCount} memor${totalCount === 1 ? "y" : "ies"} (${hybridModeLabel})${boostNote}:\n\n${results.join("\n\n---\n\n")}` }],
            };
          }
        }
        // Fall through to keyword search if hybrid/BM25 returns nothing
      }

      // Keyword / filter search fallback
      let q = supabase
        .from("memories")
        .select("id, type, name, description, content, tags, source, updated_at")
        .order("updated_at", { ascending: false })
        .limit(maxResults);

      if (type) q = q.eq("type", type);
      if (tags && tags.length > 0) q = q.overlaps("tags", tags);
      if (query) q = q.or(`name.ilike.%${query}%,description.ilike.%${query}%,content.ilike.%${query}%`);

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No memories found." }] };

      const results = data.map((m) => {
        const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        return `## ${m.name} (${m.type})${tagStr}\n_${m.description}_\n_Updated: ${m.updated_at} | Source: ${m.source}_\n\n${m.content}`;
      });

      return {
        content: [{ type: "text" as const, text: `Found ${data.length} memor${data.length === 1 ? "y" : "ies"} (keyword):\n\n${results.join("\n\n---\n\n")}` }],
      };
    }
  );

  // ── Tool: forget ────────────────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete a memory by name. The audit log preserves what was deleted.",
    {
      name: z.string().describe("Exact name of the memory to delete"),
    },
    async ({ name }) => {
      const { data: existing } = await supabase
        .from("memories")
        .select("id")
        .eq("name", name)
        .maybeSingle();

      if (!existing) return { content: [{ type: "text" as const, text: `No memory found with name "${name}"` }] };

      const { error } = await supabase.from("memories").delete().eq("id", existing.id);

      if (error) return { content: [{ type: "text" as const, text: `Error deleting: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Deleted memory "${name}". Audit log preserved.` }] };
    }
  );

  // ── Tool: add_memory_link ────────────────────────────────────────────────────
  server.tool(
    "add_memory_link",
    "Create a typed Zettelkasten link between two memories. Link types: semantic (topically related), temporal (time-ordered sequence), causal (A caused/led to B), entity (same entity referenced). Temporal and causal links receive a recall score boost.",
    {
      source_id: z.string().uuid().describe("UUID of the source memory"),
      target_id: z.string().uuid().describe("UUID of the target memory"),
      relationship: z.string().optional().describe("Relationship label, e.g. 'causes', 'precedes', 'related_to', 'references' (default: related_to)"),
      link_type: z.enum(["semantic", "temporal", "causal", "entity"]).optional().describe("MAGMA link type — semantic: topically related, temporal: time-ordered, causal: A caused B, entity: same entity (default: semantic)"),
      strength: z.number().min(0).max(1).optional().describe("Link strength 0-1 (default: 1.0)"),
    },
    async ({ source_id, target_id, relationship, link_type, strength }) => {
      // Validate both memories exist
      const { data: srcMem } = await supabase.from("memories").select("id, name").eq("id", source_id).maybeSingle();
      if (!srcMem) return { content: [{ type: "text" as const, text: `Source memory not found: ${source_id}` }] };

      const { data: tgtMem } = await supabase.from("memories").select("id, name").eq("id", target_id).maybeSingle();
      if (!tgtMem) return { content: [{ type: "text" as const, text: `Target memory not found: ${target_id}` }] };

      const rel = relationship || "related_to";
      const ltype = link_type || "semantic";
      const str = strength ?? 1.0;

      const { error } = await supabase
        .from("memory_links")
        .upsert(
          { source_id, target_id, relationship: rel, link_type: ltype, strength: str },
          { onConflict: "source_id,target_id,relationship" }
        );

      if (error) {
        // If link_type column doesn't exist yet, fall back to insert without it
        if (error.message?.includes("link_type")) {
          const { error: fallbackErr } = await supabase
            .from("memory_links")
            .upsert(
              { source_id, target_id, relationship: rel, strength: str },
              { onConflict: "source_id,target_id,relationship" }
            );
          if (fallbackErr) return { content: [{ type: "text" as const, text: `Error creating link: ${fallbackErr.message}. Note: run migrations/001_add_link_type.sql to enable typed links.` }] };
          return { content: [{ type: "text" as const, text: `Linked "${srcMem.name}" → "${tgtMem.name}" (${rel}, strength ${str.toFixed(2)}) — warning: link_type not persisted, apply migrations/001_add_link_type.sql.` }] };
        }
        return { content: [{ type: "text" as const, text: `Error creating link: ${error.message}` }] };
      }

      const boostNote = ltype === "temporal" || ltype === "causal" ? " (recall-boosted)" : "";
      return {
        content: [{ type: "text" as const, text: `Linked "${srcMem.name}" → "${tgtMem.name}" (${rel}, type:${ltype}${boostNote}, strength ${str.toFixed(2)})` }],
      };
    }
  );

  // ── Tool: list_memories ─────────────────────────────────────────────────────
  server.tool(
    "list_memories",
    "List all memories with their names, types, and descriptions. Quick overview of everything stored.",
    {
      type: z.enum(["user", "feedback", "project", "reference"]).optional().describe("Filter by type"),
    },
    async ({ type }) => {
      let q = supabase
        .from("memories")
        .select("type, name, description, tags, source, updated_at")
        .order("type")
        .order("name");

      if (type) q = q.eq("type", type);

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No memories stored." }] };

      const grouped: Record<string, string[]> = {};
      for (const m of data) {
        if (!grouped[m.type]) grouped[m.type] = [];
        const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
        grouped[m.type].push(`- **${m.name}**${tagStr} — ${m.description}`);
      }

      const sections = Object.entries(grouped)
        .map(([t, items]) => `### ${t}\n${items.join("\n")}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `${data.length} memories:\n\n${sections}` }],
      };
    }
  );

  // ── Tool: memory_log ────────────────────────────────────────────────────────
  server.tool(
    "memory_log",
    "View the audit trail of memory changes. See what was created, updated, or deleted and when.",
    {
      limit: z.number().optional().describe("Max entries (default 20)"),
      memory_name: z.string().optional().describe("Filter by memory name"),
    },
    async ({ limit, memory_name }) => {
      const maxEntries = limit || 20;

      let q = supabase
        .from("memory_log")
        .select("id, memory_id, action, old_content, new_content, source, created_at")
        .order("created_at", { ascending: false })
        .limit(maxEntries);

      if (memory_name) {
        const { data: mem } = await supabase
          .from("memories")
          .select("id")
          .eq("name", memory_name)
          .maybeSingle();

        if (mem) q = q.eq("memory_id", mem.id);
      }

      const { data, error } = await q;

      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No log entries found." }] };

      const entries = data.map((e) => {
        const preview = e.new_content
          ? e.new_content.substring(0, 100) + (e.new_content.length > 100 ? "..." : "")
          : e.old_content
            ? e.old_content.substring(0, 100) + "..."
            : "";
        return `- **${e.action}** (${e.source}) at ${e.created_at}\n  ${preview}`;
      });

      return {
        content: [{ type: "text" as const, text: `${data.length} log entries:\n\n${entries.join("\n\n")}` }],
      };
    }
  );

  // ── Tool: remember_file ─────────────────────────────────────────────────────
  if (r2) {
    server.tool(
      "remember_file",
      "Upload a file (image, config, doc, etc.) to persistent storage and link it to a memory. Pass file content as base64.",
      {
        filename: z.string().describe("Original filename with extension (e.g. network-diagram.png)"),
        content_base64: z.string().describe("File content encoded as base64"),
        content_type: z.string().optional().describe("MIME type (e.g. image/png, application/pdf). Auto-detected from extension if omitted."),
        memory_name: z.string().optional().describe("Link to an existing memory by name"),
        description: z.string().optional().describe("What this file is — used for searching later"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      },
      async ({ filename, content_base64, content_type, memory_name, description, tags }) => {
        const mimeMap: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
          webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
          json: "application/json", yaml: "text/yaml", yml: "text/yaml",
          txt: "text/plain", md: "text/markdown", csv: "text/csv",
          zip: "application/zip", tar: "application/x-tar",
        };
        const ext = filename.split(".").pop()?.toLowerCase() || "";
        const mime = content_type || mimeMap[ext] || "application/octet-stream";

        const key = `files/${Date.now()}-${filename}`;
        const body = Buffer.from(content_base64, "base64");

        try {
          await r2!.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: mime,
          }));
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `R2 upload failed: ${err.message}` }] };
        }

        // Store file reference in Supabase
        const fileRecord = {
          r2_key: key,
          filename,
          content_type: mime,
          size_bytes: body.length,
          description: description || filename,
          tags: tags || [],
          memory_name: memory_name || null,
        };

        const { error } = await supabase.from("memory_files").insert(fileRecord);
        if (error) {
          return { content: [{ type: "text" as const, text: `File uploaded to R2 but DB insert failed: ${error.message}. Key: ${key}` }] };
        }

        return {
          content: [{ type: "text" as const, text: `Stored file "${filename}" (${(body.length / 1024).toFixed(1)} KB, ${mime})\nR2 key: ${key}${memory_name ? `\nLinked to memory: ${memory_name}` : ""}` }],
        };
      }
    );

    // ── Tool: recall_file ───────────────────────────────────────────────────────
    server.tool(
      "recall_file",
      "Get a download URL for a stored file, or list stored files. URLs are presigned and valid for 1 hour.",
      {
        filename: z.string().optional().describe("Search by filename (partial match)"),
        memory_name: z.string().optional().describe("Get files linked to a memory"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        list_only: z.boolean().optional().describe("Just list files without generating URLs (default false)"),
      },
      async ({ filename, memory_name, tags, list_only }) => {
        let q = supabase
          .from("memory_files")
          .select("id, r2_key, filename, content_type, size_bytes, description, tags, memory_name, created_at")
          .order("created_at", { ascending: false })
          .limit(20);

        if (filename) q = q.ilike("filename", `%${filename}%`);
        if (memory_name) q = q.eq("memory_name", memory_name);
        if (tags && tags.length > 0) q = q.overlaps("tags", tags);

        const { data, error } = await q;

        if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
        if (!data || data.length === 0) return { content: [{ type: "text" as const, text: "No files found." }] };

        if (list_only) {
          const list = data.map((f) => {
            const size = f.size_bytes > 1024 * 1024
              ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB`
              : `${(f.size_bytes / 1024).toFixed(1)} KB`;
            const tagStr = f.tags?.length ? ` [${f.tags.join(", ")}]` : "";
            return `- **${f.filename}** (${size}, ${f.content_type})${tagStr}\n  ${f.description}${f.memory_name ? ` | linked: ${f.memory_name}` : ""}`;
          });
          return { content: [{ type: "text" as const, text: `${data.length} files:\n\n${list.join("\n")}` }] };
        }

        // Generate presigned URLs
        const results = await Promise.all(data.map(async (f) => {
          const url = await getSignedUrl(r2!, new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: f.r2_key,
          }), { expiresIn: 3600 });

          const size = f.size_bytes > 1024 * 1024
            ? `${(f.size_bytes / 1024 / 1024).toFixed(1)} MB`
            : `${(f.size_bytes / 1024).toFixed(1)} KB`;

          return `## ${f.filename} (${size})\n${f.description}\nURL (1h): ${url}`;
        }));

        return {
          content: [{ type: "text" as const, text: `${data.length} file${data.length === 1 ? "" : "s"}:\n\n${results.join("\n\n---\n\n")}` }],
        };
      }
    );

    // ── Tool: forget_file ───────────────────────────────────────────────────────
    server.tool(
      "forget_file",
      "Delete a stored file from R2 and its database record.",
      {
        filename: z.string().describe("Exact filename to delete"),
      },
      async ({ filename }) => {
        const { data: file } = await supabase
          .from("memory_files")
          .select("id, r2_key")
          .eq("filename", filename)
          .maybeSingle();

        if (!file) return { content: [{ type: "text" as const, text: `No file found: "${filename}"` }] };

        try {
          await r2!.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: file.r2_key }));
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `R2 delete failed: ${err.message}` }] };
        }

        const { error } = await supabase.from("memory_files").delete().eq("id", file.id);
        if (error) return { content: [{ type: "text" as const, text: `R2 file deleted but DB cleanup failed: ${error.message}` }] };

        return { content: [{ type: "text" as const, text: `Deleted file "${filename}" from storage and database.` }] };
      }
    );

    // ── Tool: store_file ─────────────────────────────────────────────────────
    // Large-object convention: use this instead of embedding content in Supabase
    // when the payload exceeds ~8KB. Key format: agent/YYYY-MM-DD/name.md
    server.tool(
      "store_file",
      "Write text content directly to R2 by key — no Supabase record. Use this for large payloads (>8KB) that would bloat memory storage. Key format: agent/YYYY-MM-DD/descriptive-name.md",
      {
        key: z.string().describe("R2 object key, e.g. 'wren/2026-03-26/research-notes.md'"),
        content: z.string().describe("Text content to store"),
        content_type: z.string().optional().describe("MIME type (default: text/plain for .txt, text/markdown for .md)"),
      },
      async ({ key, content, content_type }) => {
        const ext = key.split(".").pop()?.toLowerCase() || "";
        const mime = content_type || (ext === "md" ? "text/markdown" : ext === "json" ? "application/json" : "text/plain");
        const body = Buffer.from(content, "utf-8");
        try {
          await r2!.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: mime }));
          return { content: [{ type: "text" as const, text: `Stored ${body.length.toLocaleString()} bytes → ${R2_BUCKET}/${key}` }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `store_file failed: ${err.message}` }] };
        }
      }
    );

    // ── Tool: get_file ───────────────────────────────────────────────────────
    server.tool(
      "get_file",
      "Read text content from R2 by key. Companion to store_file for large-object retrieval. Returns the raw text content.",
      {
        key: z.string().describe("R2 object key to retrieve, e.g. 'wren/2026-03-26/research-notes.md'"),
      },
      async ({ key }) => {
        try {
          const response = await r2!.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
          if (!response.Body) return { content: [{ type: "text" as const, text: `Empty response for key: ${key}` }] };
          const text = await response.Body.transformToString("utf-8");
          return { content: [{ type: "text" as const, text }] };
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `get_file failed for "${key}": ${err.message}` }] };
        }
      }
    );
  }

  // ── Tool: save_skill ────────────────────────────────────────────────────────
  server.tool(
    "save_skill",
    "Save a skill — procedural knowledge about how to accomplish a specific type of task. Call this after completing a complex task (5+ steps) to capture the approach for future sessions.",
    {
      name: z.string().describe("Short slug, e.g. 'deploy-podman-compose-service'"),
      title: z.string().describe("Human-readable title, e.g. 'Deploy a Podman Compose Service'"),
      description: z.string().describe("One-line summary shown in skill index — when to use this skill"),
      content: z.string().describe("Full skill content: steps, gotchas, examples, commands. Markdown."),
      triggers: z.array(z.string()).optional().describe("Phrases that indicate this skill applies, e.g. ['deploy service', 'podman compose']"),
      platforms: z.array(z.string()).optional().describe("Platforms this applies to, e.g. ['linux', 'podman', 'svc-podman-01']"),
      source: z.string().optional().describe("Source interface (default: claude-code)"),
    },
    async ({ name, title, description, content, triggers, platforms, source }) => {
      // Security gate
      for (const [field, value] of [["name", name], ["title", title], ["description", description], ["content", content]] as Array<[string, string]>) {
        const threat = scanContent(value);
        if (threat) return { content: [{ type: "text" as const, text: `Blocked: ${field} matches threat pattern '${threat}'. Skill not saved.` }] };
      }

      const src = source || "claude-code";
      const skillTriggers = triggers || [];
      const skillPlatforms = platforms || [];
      const embedding = await embed(embedInput(name, description, content));

      const { data: existing } = await supabase.from("skills").select("id").eq("name", name).maybeSingle();

      if (existing) {
        const update: Record<string, unknown> = { title, description, content, triggers: skillTriggers, platforms: skillPlatforms, source: src };
        if (embedding) update.embedding = JSON.stringify(embedding);
        const { error } = await supabase.from("skills").update(update).eq("id", existing.id);
        if (error) return { content: [{ type: "text" as const, text: `Error updating skill: ${error.message}` }] };
        return { content: [{ type: "text" as const, text: `Updated skill "${name}"` }] };
      }

      const insert: Record<string, unknown> = { name, title, description, content, triggers: skillTriggers, platforms: skillPlatforms, source: src };
      if (embedding) insert.embedding = JSON.stringify(embedding);
      const { error } = await supabase.from("skills").insert(insert);
      if (error) return { content: [{ type: "text" as const, text: `Error saving skill: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Saved new skill "${name}" — "${title}"` }] };
    }
  );

  // ── Tool: recall_skill ───────────────────────────────────────────────────────
  server.tool(
    "recall_skill",
    "Find a skill by semantic search or name. Returns full content of matching skills.",
    {
      query: z.string().optional().describe("What you're trying to do — semantic search"),
      name: z.string().optional().describe("Exact skill name to retrieve"),
      limit: z.number().optional().describe("Max results (default 3)"),
    },
    async ({ query, name, limit }) => {
      const maxResults = limit || 3;

      if (name) {
        const { data, error } = await supabase.from("skills").select("*").eq("name", name).maybeSingle();
        if (error || !data) return { content: [{ type: "text" as const, text: `Skill "${name}" not found.` }] };
        await supabase.from("skills").update({ use_count: (data.use_count || 0) + 1 }).eq("id", data.id);
        return { content: [{ type: "text" as const, text: `# ${data.title}\n_${data.description}_\n\n${data.content}` }] };
      }

      if (query) {
        const queryEmbedding = await embed(query);
        if (queryEmbedding) {
          const { data, error } = await supabase.rpc("match_skills", { query_embedding: JSON.stringify(queryEmbedding), match_count: maxResults });
          if (!error && data?.length > 0) {
            for (const s of data) await supabase.from("skills").update({ use_count: (s.use_count || 0) + 1 }).eq("id", s.id);
            const results = data.map((s: any) => `# ${s.title} (${(s.similarity * 100).toFixed(0)}% match)\n_${s.description}_\n\n${s.content}`);
            return { content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }] };
          }
        }
        // keyword fallback
        const { data, error } = await supabase.from("skills").select("*")
          .or(`name.ilike.%${query}%,title.ilike.%${query}%,description.ilike.%${query}%`).limit(maxResults);
        if (error || !data?.length) return { content: [{ type: "text" as const, text: "No matching skills found." }] };
        const results = data.map((s) => `# ${s.title}\n_${s.description}_\n\n${s.content}`);
        return { content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }] };
      }

      return { content: [{ type: "text" as const, text: "Provide a query or name." }] };
    }
  );

  // ── Tool: list_skills ────────────────────────────────────────────────────────
  server.tool(
    "list_skills",
    "List all saved skills with their names and descriptions. Quick index of what procedural knowledge is available.",
    {},
    async () => {
      const { data, error } = await supabase.from("skills")
        .select("name, title, description, triggers, use_count, updated_at")
        .order("use_count", { ascending: false });
      if (error || !data?.length) return { content: [{ type: "text" as const, text: "No skills saved yet." }] };
      const lines = data.map((s) => {
        const t = s.triggers?.length ? ` [${s.triggers.slice(0, 3).join(", ")}]` : "";
        return `- **${s.name}**${t} — ${s.description} (used ${s.use_count}x)`;
      });
      return { content: [{ type: "text" as const, text: `${data.length} skills:\n\n${lines.join("\n")}` }] };
    }
  );

  // ── Tool: delete_skill ───────────────────────────────────────────────────────
  server.tool(
    "delete_skill",
    "Delete a skill by name when it's outdated or replaced by a better approach.",
    {
      name: z.string().describe("Exact skill name to delete"),
    },
    async ({ name }) => {
      const { error } = await supabase.from("skills").delete().eq("name", name);
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: `Deleted skill "${name}".` }] };
    }
  );

  // ── Tool: list_conflicts ────────────────────────────────────────────────────
  server.tool(
    "list_conflicts",
    "List unresolved memory conflicts — memories that may contradict each other. Review and resolve manually.",
    { resolved: z.boolean().optional().describe("If true, show resolved conflicts too (default: unresolved only)") },
    async ({ resolved }) => {
      const q = supabase
        .from("memory_conflicts")
        .select("id, conflict_type, description, created_at, memory_a_id, memory_b_id")
        .order("created_at", { ascending: false })
        .limit(20);
      if (!resolved) q.eq("resolved", false);
      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data?.length) return { content: [{ type: "text" as const, text: "No unresolved conflicts." }] };

      // Fetch memory names
      const ids = [...new Set(data.flatMap((c) => [c.memory_a_id, c.memory_b_id]))];
      const { data: mems } = await supabase.from("memories").select("id, name").in("id", ids);
      const nameMap = Object.fromEntries((mems || []).map((m) => [m.id, m.name]));

      const lines = data.map((c) => {
        const a = nameMap[c.memory_a_id] || c.memory_a_id;
        const b = nameMap[c.memory_b_id] || c.memory_b_id;
        return `⚠️ **${a}** vs **${b}** (${c.conflict_type})\n  ${c.description}`;
      });
      return { content: [{ type: "text" as const, text: `${data.length} conflict${data.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}` }] };
    }
  );

  // ── Tool: find_duplicates ────────────────────────────────────────────────────
  server.tool(
    "find_duplicates",
    "Find near-duplicate memories by cosine similarity. Use this to identify redundant memories that could be merged.",
    {
      threshold: z.number().optional().describe("Similarity threshold 0-1 (default 0.90 — very similar)"),
      limit: z.number().optional().describe("Max pairs to return (default 20)"),
    },
    async ({ threshold = 0.90, limit = 20 }) => {
      const { data, error } = await supabase.rpc("find_duplicate_memories", {
        similarity_threshold: threshold,
        max_pairs: limit,
      });
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data?.length) return { content: [{ type: "text" as const, text: `No near-duplicate memories found at threshold ${threshold}.` }] };

      const lines = (data as any[]).map((row) =>
        `- **${row.memory_a_name}** ↔ **${row.memory_b_name}** (${(row.similarity * 100).toFixed(1)}% similar)`
      );
      return {
        content: [{ type: "text" as const, text: `${data.length} near-duplicate pair${data.length === 1 ? "" : "s"} (threshold ${threshold}):\n\n${lines.join("\n")}\n\nUse merge_memories to combine a pair.` }],
      };
    }
  );

  // ── Tool: merge_memories ─────────────────────────────────────────────────────
  server.tool(
    "merge_memories",
    "Merge two memories — keep the primary, absorb tags from secondary, redirect all links, delete secondary. Use after find_duplicates.",
    {
      primary_name: z.string().describe("Name of the memory to keep"),
      secondary_name: z.string().describe("Name of the memory to absorb and delete"),
      merged_content: z.string().optional().describe("Replacement content for the primary memory after merge. If omitted, primary content is unchanged."),
    },
    async ({ primary_name, secondary_name, merged_content }) => {
      // Fetch both
      const { data: primary } = await supabase.from("memories").select("id, type, description, content, tags, source").eq("name", primary_name).maybeSingle();
      const { data: secondary } = await supabase.from("memories").select("id, tags, content").eq("name", secondary_name).maybeSingle();

      if (!primary) return { content: [{ type: "text" as const, text: `Primary memory "${primary_name}" not found.` }] };
      if (!secondary) return { content: [{ type: "text" as const, text: `Secondary memory "${secondary_name}" not found.` }] };

      // Merge tags (union)
      const mergedTags = [...new Set([...(primary.tags || []), ...(secondary.tags || [])])];

      // Optionally update content
      const update: Record<string, unknown> = { tags: mergedTags };
      if (merged_content) {
        update.content = merged_content;
        const newEmbedding = await embed(embedInput(primary_name, primary.description, merged_content));
        if (newEmbedding) update.embedding = JSON.stringify(newEmbedding);
      }

      const { error: updateError } = await supabase.from("memories").update(update).eq("id", primary.id);
      if (updateError) return { content: [{ type: "text" as const, text: `Error updating primary: ${updateError.message}` }] };

      // Merge via DB function (redirect links, delete secondary)
      const { error: mergeError } = await supabase.rpc("merge_memory_into", {
        primary_id: primary.id,
        secondary_id: secondary.id,
      });
      if (mergeError) return { content: [{ type: "text" as const, text: `Error in merge RPC: ${mergeError.message}` }] };

      const contentNote = merged_content ? " Content updated." : "";
      const tagNote = mergedTags.length > (primary.tags?.length || 0) ? ` Tags merged: [${mergedTags.join(", ")}].` : "";
      return {
        content: [{ type: "text" as const, text: `Merged "${secondary_name}" into "${primary_name}".${contentNote}${tagNote} Secondary memory deleted, links redirected.` }],
      };
    }
  );

  // ── Tool: list_stale_memories ────────────────────────────────────────────────
  server.tool(
    "list_stale_memories",
    "Find memories that haven't been accessed recently, have low use counts, and no outgoing links. Candidates for review or deletion.",
    {
      days_inactive: z.number().optional().describe("Inactivity threshold in days (default 60)"),
      max_uses: z.number().optional().describe("Max access_count to consider stale (default 1)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ days_inactive = 60, max_uses = 1, limit = 20 }) => {
      const { data, error } = await supabase.rpc("find_stale_memories", {
        days_inactive,
        max_uses,
        result_limit: limit,
      });
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      if (!data?.length) return { content: [{ type: "text" as const, text: "No stale memories found." }] };

      const lines = (data as any[]).map((m) => {
        const age = m.updated_at ? `last updated ${new Date(m.updated_at).toLocaleDateString()}` : "never updated";
        const accessed = m.accessed_at ? `accessed ${new Date(m.accessed_at).toLocaleDateString()}` : "never accessed";
        return `- **${m.name}** (${m.type}) — ${m.description}\n  source:${m.source} | uses:${m.access_count} | ${age} | ${accessed}`;
      });
      return {
        content: [{ type: "text" as const, text: `${data.length} stale memor${data.length === 1 ? "y" : "ies"} (inactive ${days_inactive}d, uses ≤${max_uses}, no links):\n\n${lines.join("\n\n")}\n\nReview and use forget() to prune any that are outdated.` }],
      };
    }
  );

  // ── Tool: get_memory_block ───────────────────────────────────────────────────
  server.tool(
    "get_memory_block",
    "Read a named memory block for a specific agent. Used for cross-agent whisper channel (e.g. guidance, pending_items, project_context).",
    {
      agent: z.string().describe("Agent name, e.g. 'wren', 'iris'"),
      block_name: z.string().describe("Block name: guidance, user_prefs, project_context, session_patterns, pending_items, active_task"),
    },
    async ({ agent, block_name }) => {
      const { data, error } = await supabase
        .from("memory_blocks")
        .select("content, updated_at, updated_by")
        .eq("agent", agent)
        .eq("block_name", block_name)
        .maybeSingle();

      if (error) return { content: [{ type: "text" as const, text: `Error reading memory block: ${error.message}` }] };
      if (!data) return { content: [{ type: "text" as const, text: `No block '${block_name}' found for agent '${agent}'.` }] };

      const ts = data.updated_at ? ` (updated ${new Date(data.updated_at).toISOString().slice(0, 16)} by ${data.updated_by || "unknown"})` : "";
      return {
        content: [{ type: "text" as const, text: `[${agent}/${block_name}]${ts}\n\n${data.content}` }],
      };
    }
  );

  // ── Tool: set_memory_block ───────────────────────────────────────────────────
  server.tool(
    "set_memory_block",
    "Upsert a named memory block for a specific agent. Use this for the cross-agent whisper channel — write to another agent's guidance or pending_items block.",
    {
      agent: z.string().describe("Agent name, e.g. 'wren', 'iris'"),
      block_name: z.string().describe("Block name: guidance, user_prefs, project_context, session_patterns, pending_items, active_task"),
      content: z.string().describe("Full content to store in the block"),
      updated_by: z.string().optional().describe("Who is writing (default: caller identity)"),
    },
    async ({ agent, block_name, content, updated_by }) => {
      const threat = scanContent(content);
      if (threat) {
        return { content: [{ type: "text" as const, text: `Blocked: content matches threat pattern '${threat}'. Block not written.` }] };
      }

      const contentHash = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))
      ).toString("hex").slice(0, 16);

      const { error } = await supabase
        .from("memory_blocks")
        .upsert(
          {
            agent,
            block_name,
            content,
            content_hash: contentHash,
            updated_by: updated_by || "claude-code",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "agent,block_name" }
        );

      if (error) return { content: [{ type: "text" as const, text: `Error writing memory block: ${error.message}` }] };
      return {
        content: [{ type: "text" as const, text: `Wrote block '${block_name}' for agent '${agent}' (hash: ${contentHash}).` }],
      };
    }
  );

  // ── Home Assistant Tools ─────────────────────────────────────────────────────
  if (HA_URL && HA_TOKEN) {
    const haFetch = async (path: string, method = "GET", body?: object) => {
      const res = await fetch(`${HA_URL}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HA API ${res.status}: ${await res.text()}`);
      return res.json();
    };

    // ── Tool: ha_get_states ────────────────────────────────────────────────────
    server.tool(
      "ha_get_states",
      "Get Home Assistant entity states. Optionally filter by domain (light, switch, climate, sensor, etc.) or entity_id prefix.",
      {
        domain: z.string().optional().describe("Filter by domain: light, switch, climate, sensor, binary_sensor, media_player, person, device_tracker, etc."),
        search: z.string().optional().describe("Filter by entity_id substring or friendly_name"),
      },
      async ({ domain, search }) => {
        const states = await haFetch("/states") as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
        let filtered = states;
        if (domain) filtered = filtered.filter((s) => s.entity_id.startsWith(`${domain}.`));
        if (search) {
          const q = search.toLowerCase();
          filtered = filtered.filter((s) =>
            s.entity_id.includes(q) ||
            String(s.attributes.friendly_name || "").toLowerCase().includes(q)
          );
        }
        const lines = filtered.map((s) => {
          const name = s.attributes.friendly_name || s.entity_id;
          const extra: string[] = [];
          if (s.attributes.temperature !== undefined) extra.push(`temp=${s.attributes.temperature}`);
          if (s.attributes.brightness !== undefined) extra.push(`brightness=${s.attributes.brightness}`);
          if (s.attributes.battery_level !== undefined) extra.push(`battery=${s.attributes.battery_level}%`);
          return `${s.entity_id}: **${s.state}**  (${name})${extra.length ? "  " + extra.join(", ") : ""}`;
        });
        return { content: [{ type: "text" as const, text: filtered.length ? lines.join("\n") : "No matching entities." }] };
      }
    );

    // ── Tool: ha_call_service ──────────────────────────────────────────────────
    server.tool(
      "ha_call_service",
      "Call a Home Assistant service to control devices. Examples: turn on/off lights, set climate, trigger automations.",
      {
        domain: z.string().describe("Service domain: light, switch, climate, automation, script, media_player, etc."),
        service: z.string().describe("Service name: turn_on, turn_off, toggle, set_temperature, trigger, etc."),
        entity_id: z.string().optional().describe("Target entity ID, or comma-separated list. Omit for services that don't need one."),
        data: z.record(z.unknown()).optional().describe("Additional service data (e.g. temperature, brightness, hvac_mode)"),
      },
      async ({ domain, service, entity_id, data }) => {
        const payload: Record<string, unknown> = { ...data };
        if (entity_id) payload.entity_id = entity_id;
        await haFetch(`/services/${domain}/${service}`, "POST", payload);
        const target = entity_id || `${domain}.${service}`;
        return { content: [{ type: "text" as const, text: `Called ${domain}.${service} on ${target} ✅` }] };
      }
    );

    // ── Tool: ha_get_history ───────────────────────────────────────────────────
    server.tool(
      "ha_get_history",
      "Get state history for a Home Assistant entity over the past N hours.",
      {
        entity_id: z.string().describe("Entity ID to get history for"),
        hours: z.number().optional().describe("Hours of history to fetch (default 24, max 168)"),
      },
      async ({ entity_id, hours = 24 }) => {
        const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const data = await haFetch(`/history/period/${start}?filter_entity_id=${entity_id}`) as Array<Array<{ state: string; last_changed: string }>>;
        const history = data?.[0] || [];
        if (!history.length) return { content: [{ type: "text" as const, text: `No history for ${entity_id} in the last ${hours}h.` }] };
        const lines = history.slice(-50).map((s) => {
          const ts = new Date(s.last_changed).toLocaleString();
          return `${ts}: ${s.state}`;
        });
        return { content: [{ type: "text" as const, text: `${entity_id} — last ${lines.length} state changes:\n\n${lines.join("\n")}` }] };
      }
    );
  }

  return server;
}

// ── Express + Transport ─────────────────────────────────────────────────────
const app = express();

const haEnabled = !!(HA_URL && HA_TOKEN);

app.get("/health", (_req: Request, res: Response) => {
  const toolCount = (r2 ? 15 : 10) + (haEnabled ? 3 : 0) + 6; // +6: memory blocks (get/set) + add_memory_link; r2: remember_file, recall_file, forget_file, store_file, get_file
  res.json({ status: "ok", service: "memory-mcp-server", version: "4.2.0", tools: toolCount, r2: r2Enabled, ha: haEnabled });
});

// Map to store transports and their servers by session ID
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session — new server instance
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  const server = createMcpServer();

  transport.onclose = () => {
    const sid = (transport as any).sessionId;
    if (sid) sessions.delete(sid);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res);

  // Session ID is set during handleRequest, so store after
  const sid = (transport as any).sessionId;
  if (sid) sessions.set(sid, { transport, server });
});

// Handle GET for SSE streams
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No session. Send POST /mcp first." });
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
    return;
  }
  res.status(400).json({ error: "No session found." });
});

app.listen(PORT, "0.0.0.0", async () => {
  const toolCount = (r2 ? 15 : 10) + (haEnabled ? 3 : 0) + 6;
  console.log(`Memory MCP Server v4.1.0 — http://0.0.0.0:${PORT}/mcp (${toolCount} tools, R2: ${r2Enabled ? "enabled" : "disabled"}, HA: ${haEnabled ? "enabled" : "disabled"})`);
  console.log(`Health check — http://0.0.0.0:${PORT}/health`);
  await applyStartupMigrations();
  startMemorySyncListener();
});

// ── Cross-agent memory sync (Supabase Realtime) ──────────────────────────────
// Subscribes to high-importance memory writes from other agents using raw
// Phoenix v1.0.0 WebSocket — supabase-js hardcodes vsn=2.0.0 which this
// project's Realtime server doesn't support.
function startMemorySyncListener() {
  const RT_URL = `${SUPABASE_URL.replace("https://", "wss://")}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;

  let ws: any = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let ref = 0;

  function cleanup() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  function connect() {
    cleanup();
    ws = new WebSocket(RT_URL);

    ws.on("open", () => {
      ref = 0;
      // Join the channel
      ws!.send(JSON.stringify({
        topic: "realtime:memory-sync",
        event: "phx_join",
        payload: { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [{ event: "*", schema: "public", table: "memories" }] } },
        ref: String(++ref),
        join_ref: "1",
      }));
      // Heartbeat every 25s
      heartbeat = setInterval(() => {
        ws!.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }));
      }, 25_000);
    });

    ws.on("message", (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.event === "phx_reply" && msg.payload?.status === "ok" && msg.topic === "realtime:memory-sync") {
        console.log("[memory-sync] Realtime subscription active — watching importance>=0.8 cross-agent writes");
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        return;
      }

      if (msg.event === "postgres_changes") {
        const rec = msg.payload?.data?.record || msg.payload?.record;
        if (!rec) return;
        const importance = rec.importance_score ?? 0;
        if (importance < 0.8) return;
        const src = rec.source || "unknown";
        if (src === "wren") return;
        const event = (msg.payload?.data?.type || "CHANGE").toUpperCase();
        console.log(`[memory-sync] ${event} from ${src}: "${rec.name}" (importance=${importance}, type=${rec.type})`);
      }
    });

    ws.on("error", (e: any) => {
      console.warn(`[memory-sync] WS error: ${e.message} — reconnecting in 30s`);
      cleanup();
      retryTimer = setTimeout(connect, 30_000);
    });

    ws.on("close", () => {
      cleanup();
      retryTimer = setTimeout(connect, 30_000);
    });
  }

  connect();
  process.on("SIGTERM", cleanup);
  process.on("SIGINT",  cleanup);
}
