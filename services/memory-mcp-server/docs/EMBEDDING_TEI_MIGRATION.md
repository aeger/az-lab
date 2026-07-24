# Embedding backend migration: Ollama → TEI (scoping + gated cutover)

**Status:** SCOPED — groundwork laid, cutover **NOT** executed (needs Jeff sign-off).
**Origin:** 2026-07-24 Daily Self-Improvement Research rec 1 (TIER 1 reliability).
**Author:** Wren.

## Why

On **2026-07-15 the Ollama container silently wedged for ~38h**: `podman ps` reported
`Up` while every `/api/embeddings` call failed. Because `embed()` degrades to `null` on
failure and the backfill job only re-embeds rows where `embedding IS NULL`, the vector
lane quietly served a degraded corpus for a day and a half with no alert. Ollama is the
single flakiest dependency in the recall path.

We already run **TEI** (`az-tei-reranker`) for cross-encoder reranking. TEI also serves
embeddings and — unlike our Ollama container — exposes a real `/health` readiness gate,
so a wedge becomes *detectable* instead of silent.

## Compatibility scope (the "scope dim/model first" ask)

| | current (Ollama) | proposed (TEI) |
|---|---|---|
| model | `nomic-embed-text` | `nomic-ai/nomic-embed-text-v1.5` (same base model) |
| dims | **768** | **768** — identical |
| pgvector column | `vector(768)` | **unchanged** — no schema migration |
| corpus to re-embed | — | **810 memories + 130 episodes ≈ 940 rows** |

**Dimension:** identical (768). The `vector(768)` column and every downstream RRF /
A-MAC path are unaffected — this is the reason nomic-v1.5 is chosen over bge-base
(also 768d but a different family, larger semantic drift).

**The one real wrinkle — task prefixes.** nomic-embed-text requires instruction
prefixes (`search_query:` / `search_document:`). Ollama applies these *internally*;
**TEI does not.** So a naive repoint would embed documents and queries with no prefix
and silently lose retrieval quality. Two consequences:

1. The app must add the prefixes itself: `search_document:` at write time, `search_query:`
   at recall time. (See patch below.)
2. Old rows were embedded by Ollama (prefixed one way); new TEI rows would be prefixed
   by us. Mixing the two degrades cosine similarity. **→ a full corpus re-embed is
   required on cutover**, not optional.

**Re-embed cost:** ~940 embed calls on a CPU TEI instance ≈ a few minutes of compute;
the cost is operational risk (must be measured), not dollars or time. The existing
backfill loop already walks `embedding IS NULL` rows — a one-shot re-embed script can
reuse it after nulling embeddings in a transaction with a verified backup first
(constitution rule 1).

## Groundwork already landed (safe, reversible, dormant)

- **`compose.yml`**: added `tei-embed` (nomic-embed-text-v1.5, port 8081, `/health`
  gate, own model-cache volume). **Dormant** — nothing reads it until `EMBED_BACKEND=tei`.
- **`compose.yml`**: `memory-mcp` gains `EMBED_BACKEND` (default `ollama`) +
  `TEI_EMBED_URL`. Default preserves current behaviour exactly.

Neither change alters running behaviour until the flip; both are committed for review.

## Code patch (apply at cutover — NOT yet applied)

`src/index.ts` currently hard-codes the Ollama embed call. Replace `embed()` with a
backend-aware version that (a) supports TEI with nomic prefixes and (b) **detects a
wedge** instead of silently returning `null`:

```ts
const EMBED_BACKEND = process.env.EMBED_BACKEND || "ollama";       // 'ollama' | 'tei'
const TEI_EMBED_URL = process.env.TEI_EMBED_URL || "http://tei-embed:8081";

// nomic-v1.5 needs task prefixes; Ollama adds them internally, TEI does not.
async function embed(text: string, kind: "query" | "document" = "document"): Promise<number[] | null> {
  try {
    if (EMBED_BACKEND === "tei") {
      const prefixed = `search_${kind}: ${text}`;
      const res = await fetch(`${TEI_EMBED_URL}/embed`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: prefixed }),
      });
      if (!res.ok) throw new Error(`TEI embed ${res.status}`);
      const json = await res.json() as number[][];
      return json[0];
    }
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
    const json = await res.json() as { embedding: number[] };
    return json.embedding;
  } catch (err: any) {
    // WEDGE DETECTION — the fix for 2026-07-15. Don't silently degrade: count
    // consecutive failures and raise a sentinel_notifications row past a threshold
    // so a stuck backend surfaces in minutes, not 38h.
    recordEmbedFailure(err);
    return null;
  }
}
```

Plus: pass `kind: "query"` from the `recall` path and `"document"` from `remember` /
backfill, and add `recordEmbedFailure()` → after N consecutive failures insert a
`sentinel_notifications` row (`source='services', severity='high'`) + Discord ping.

## Gated cutover checklist (do in order; stop on any red)

1. **Baseline** the eval — done: `retrieval_regression.py run --tag baseline-ndcg-20260724`
   (recall@5=0.500, nDCG@10=0.374). This is the number to beat/hold.
2. Start `tei-embed`, confirm `curl tei-embed:8081/health` is 200 and `/embed` returns 768d.
3. Apply the `embed()` patch, rebuild memory-mcp, keep `EMBED_BACKEND=ollama` — verify no regression (`run --tag post-patch-ollama --compare baseline-ndcg-20260724`).
4. **Backup** `memories.embedding` + `agent_episodes.embedding` (constitution rule 1).
5. Re-embed the whole corpus via TEI (with `search_document:` prefix) in a script that
   verifies row counts before/after.
6. Flip `EMBED_BACKEND=tei`, redeploy, and `run --tag post-tei --compare baseline-ndcg-20260724`.
   **Accept only if recall@5 and nDCG@10 hold within tolerance.** Roll back (restore
   embeddings + `EMBED_BACKEND=ollama`) otherwise.
7. Decommission the Ollama embed dependency once TEI is proven over a few days.

## Recommendation

Land the groundwork (this commit). Schedule the cutover (steps 2-7) as a supervised
task with Jeff present — it re-embeds the entire production corpus and is only *cheaply*
reversible with the step-4 backup. The eval harness (now nDCG-capable) is the gate that
makes the flip safe to measure rather than guess.
