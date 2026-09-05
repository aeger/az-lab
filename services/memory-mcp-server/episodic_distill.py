#!/usr/bin/env python3
"""
Episodic → Semantic → Procedural auto-distillation pipeline.

Phase 0: Consolidates pure memory_class=episodic rows (any access count, older
than 6h) into semantic memories.

Phase 1: Queries episodic memories with access_count >= 3 (not yet consolidated),
clusters by semantic similarity, distills each cluster into a stable
semantic fact, and inserts as type=semantic with Zettelkasten links
back to the source episodes.

Phase 2: Queries project memories 7-14 days old with access_count >= 2 (not yet
consolidated), distills each cluster into a reference memory (permanent
operational knowledge).

Phase 3: Weekly 30-day consolidation (only runs under --weekly).

Phase 4: Staleness sweep — delegates to the flag_stale_memories() DB function,
the single shared rule also driven every 24h by startStalenessJob in src/index.ts.
(Migration 057's comments called this "Phase 3"; that was wrong — corrected in 060.)

Phase numbering is non-contiguous on a normal nightly run: 0, 1, 2, 4 execute and
3 is weekly-only. That is intentional, not a gap.

Based on ElephantBroker 3-session promotion threshold and CraniMem
scheduled consolidation replay pattern.

LLM priority: NemoClaw (on-prem) > claude-haiku-4-5 (Anthropic API) > heuristic
- NemoClaw: preferred when NVIDIA_API_KEY set (on-prem, no token cost)
- Haiku: fallback when ANTHROPIC_API_KEY set (low-cost cloud, ~$0.25/MTok input)
- Heuristic: always available, no LLM needed

NemoClaw model selection:
- TRIAGE_MODEL (default google/gemma-4-31b-it): triage/summarization callsites.
  Per benchmarks/triage_bench_2026-04-30, Gemma-4 31B IT is 1.3-2.2x faster
  wall-clock than Nemotron 120B on these workloads with no quality regression
  at adequate token budgets, and avoids Nemotron's "thinking preamble" leak
  at low max_tokens.
- NEMOCLAW_MODEL (default Nemotron 120B): reserved for future hard-reasoning
  callsites (multi-step planning, code generation, complex inference).

Systemd timer: episodic-distill.timer (nightly at 03:00 UTC)
"""

import os
import re
import sys
import json
import logging
import httpx
import numpy as np
from datetime import datetime, timezone, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY  = os.environ.get("SUPABASE_SECRET_KEY", "")
MEMORY_MCP_URL = os.environ.get("MEMORY_MCP_URL", "http://localhost:3100")
NEMOCLAW_URL  = os.environ.get("NEMOCLAW_URL", "https://integrate.api.nvidia.com")
NEMOCLAW_KEY  = os.environ.get("NVIDIA_API_KEY", "")
NEMOCLAW_MODEL = os.environ.get("NEMOCLAW_MODEL", "nvidia/nemotron-3-super-120b-a12b")
TRIAGE_MODEL  = os.environ.get("TRIAGE_MODEL", "google/gemma-4-31b-it")
# Floor max_tokens at 128 for any Nemotron callsite — lower budgets crowd out
# Nemotron's chain-of-thought preamble and produce truncated/garbage output.
NEMOTRON_MIN_MAX_TOKENS = 128
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
HAIKU_MODEL   = os.environ.get("HAIKU_MODEL", "claude-haiku-4-5")

MIN_ACCESS_COUNT = int(os.environ.get("MIN_ACCESS_COUNT", "3"))
PROJECT_MIN_ACCESS_COUNT = int(os.environ.get("PROJECT_MIN_ACCESS_COUNT", "2"))
CLUSTER_THRESHOLD = float(os.environ.get("CLUSTER_THRESHOLD", "0.82"))
MAX_CLUSTERS = int(os.environ.get("MAX_CLUSTERS", "20"))
CONSOLIDATED_TAG = "consolidated"
PROJECT_AGE_MIN_DAYS = int(os.environ.get("PROJECT_AGE_MIN_DAYS", "7"))
PROJECT_AGE_MAX_DAYS = int(os.environ.get("PROJECT_AGE_MAX_DAYS", "14"))
WEEKLY_LOOKBACK_DAYS = int(os.environ.get("WEEKLY_LOOKBACK_DAYS", "30"))
DISCORD_CHANNEL = "1012721652049657896"
AGENT_BUS_URL = os.environ.get("AGENT_BUS_URL", "http://localhost:8765")
AGENT_BUS_SECRET = os.environ.get("AGENT_BUS_SECRET", "")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger(__name__)

# ── Load env from .env file ───────────────────────────────────────────────────
def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

# ── Supabase helpers ──────────────────────────────────────────────────────────
def supa_get(path: str, params: dict = None) -> list:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    r = httpx.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def supa_post(path: str, data: dict | list) -> dict | list:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    r = httpx.post(f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, json=data, timeout=30)
    r.raise_for_status()
    return r.json()

def supa_patch(path: str, params: dict, data: dict):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    r = httpx.patch(f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, params=params, json=data, timeout=30)
    r.raise_for_status()

def upsert_memory_by_name(payload: dict) -> str | None:
    """Insert a memory, or UPDATE the existing active row with the same name in
    place. The distillation writers re-emit stable names (e.g. 'weekly-ref:...',
    'ref:...', 'semantic:...') on every run; a blind POST created a NEW active row
    each time, so a name accumulated one duplicate per run (the MEMORY.md churn
    root cause). This mirrors the MCP `remember` tool's name-keyed update-in-place
    and is enforced at the DB layer by the partial unique index
    `memories(name) WHERE is_active`. Returns the row id."""
    name = payload["name"]
    existing = supa_get("memories", {
        "name": f"eq.{name}", "is_active": "eq.true",
        "select": "id", "order": "created_at.desc", "limit": "1",
    })
    if existing:
        mid = existing[0]["id"]
        patch = {k: payload[k] for k in
                 ("type", "description", "content", "tags", "source", "importance_score")
                 if k in payload}
        patch["updated_at"] = datetime.now(timezone.utc).isoformat()
        supa_patch("memories", {"id": f"eq.{mid}"}, patch)
        return mid
    result = supa_post("memories", payload)
    if isinstance(result, list) and result:
        return result[0].get("id")
    return None

DATE_FRAG_RE = re.compile(r"\s*[-—:]?\s*\d{4}-\d{2}-\d{2}\s*")


def cluster_ref_name(cluster_mems: list, prefix: str = "weekly-ref") -> str:
    """Stable, honest name for a consolidated cluster, under the given prefix.

    The name has to be a function of cluster *membership*, not of a mutable
    counter. Naming the reference after the highest-`access_count` member made
    the key wobble between runs: as read counts shifted, one cluster could
    re-emit under a new name (starting a fresh duplicate family) while an
    unrelated cluster silently overwrote an old name in place. Dated log titles
    are stripped too — the summariser is told to omit ephemeral dates, so
    inheriting one labels the reference with a date it does not describe.
    """
    names = sorted(m["name"] for m in cluster_mems)
    undated = [n for n in names if not DATE_FRAG_RE.search(n)]
    label = DATE_FRAG_RE.sub(" ", (undated or names)[0])
    label = re.sub(r"\s{2,}", " ", label).strip(" -—:/|,")
    return f"{prefix}:{label or (undated or names)[0]}"

# ── Clustering ────────────────────────────────────────────────────────────────
def cosine_sim(a: list, b: list) -> float:
    va, vb = np.array(a), np.array(b)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / denom) if denom > 0 else 0.0

def cluster_memories(memories: list) -> list[list]:
    """Greedy clustering: group memories with cosine similarity > CLUSTER_THRESHOLD."""
    assigned = [False] * len(memories)
    clusters = []

    for i, mem in enumerate(memories):
        if assigned[i]:
            continue
        cluster = [i]
        assigned[i] = True
        emb_i = mem.get("embedding")
        if not emb_i:
            continue
        for j in range(i + 1, len(memories)):
            if assigned[j]:
                continue
            emb_j = memories[j].get("embedding")
            if not emb_j:
                continue
            if cosine_sim(emb_i, emb_j) >= CLUSTER_THRESHOLD:
                cluster.append(j)
                assigned[j] = True
        if len(cluster) >= 2:
            clusters.append(cluster)

    return clusters

# ── LLM summarization ─────────────────────────────────────────────────────────
def summarize_cluster_llm(memories: list) -> str | None:
    """Summarize a cluster of episodic memories via NemoClaw using TRIAGE_MODEL (gemma-4-31b-it)."""
    if not NEMOCLAW_KEY:
        return None

    snippets = "\n".join([
        f"- [{m['name']}]: {m['content'][:300]}"
        for m in memories[:6]
    ])
    prompt = (
        "You are a knowledge distillation system. The following episodic memories "
        "were repeatedly accessed and are semantically related. Distill them into a "
        "single, stable, declarative semantic fact (1-3 sentences). "
        "Be concise, factual, and remove ephemeral details.\n\n"
        f"Episodic memories:\n{snippets}\n\n"
        "Distilled semantic fact:"
    )

    try:
        r = httpx.post(
            f"{NEMOCLAW_URL}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {NEMOCLAW_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": TRIAGE_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max(256, NEMOTRON_MIN_MAX_TOKENS),
                "temperature": 0.3,
            },
            timeout=45,
        )
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log.warning(f"LLM summarization failed: {e}")
    return None

def summarize_cluster_heuristic(memories: list) -> str:
    """Fallback: combine the most-accessed memories' content as the semantic fact."""
    sorted_mems = sorted(memories, key=lambda m: m.get("access_count", 0), reverse=True)
    top = sorted_mems[:3]
    parts = [f"{m['name']}: {m['content'][:200]}" for m in top]
    return " | ".join(parts)

# Shared Max-plan call helper (Tier 0 OAuth / Max bucket -> Tier 1 API key).
sys.path.insert(0, os.path.expanduser("~/claude/lib"))
try:
    from claude_call import call_claude as _shared_claude_call
except Exception:  # pragma: no cover - resilience if lib path is missing
    _shared_claude_call = None


def _haiku_available() -> bool:
    """Haiku path works whenever the shared Tier-0-first chain imported (no local
    API key needed) — or, legacy-only, when a direct API key is present."""
    return _shared_claude_call is not None or bool(ANTHROPIC_API_KEY)


def _call_claude_haiku(prompt: str, max_tokens: int = 256) -> str | None:
    """Distill via Claude on the Max subscription (Tier 0 only). Returns text, or
    None on failure — the caller then falls back to NemoClaw or the heuristic.

    Deliberately NOT allowed to reach the billable Tier 1 API key: this is an
    unattended background job, and a silent charge is worse than a cheaper
    distillation."""
    if _shared_claude_call is not None:
        try:
            res = _shared_claude_call(
                [{"role": "user", "content": prompt}],
                model=HAIKU_MODEL, max_tokens=max_tokens, allow_tiers=(0,))
            return (res.get("content") or "").strip() or None
        except Exception as e:
            log.warning(f"shared claude_call failed: {e}")
            return None

    # Legacy fallback: direct Haiku via API key (only if the shared helper is unavailable).
    if not ANTHROPIC_API_KEY:
        return None
    try:
        r = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": HAIKU_MODEL,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        if r.status_code == 200:
            return r.json()["content"][0]["text"].strip()
        log.warning(f"Haiku API returned {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.warning(f"Haiku API call failed: {e}")
    return None

def summarize_cluster_haiku(memories: list) -> str | None:
    """Distill a cluster of episodic memories using claude-haiku-4-5 (cost-efficient fallback)."""
    if not _haiku_available():
        return None
    snippets = "\n".join([
        f"- [{m['name']}]: {m['content'][:300]}"
        for m in memories[:6]
    ])
    prompt = (
        "You are a knowledge distillation system. The following episodic memories "
        "were repeatedly accessed and are semantically related. Distill them into a "
        "single, stable, declarative semantic fact (1-3 sentences). "
        "Be concise, factual, and remove ephemeral details.\n\n"
        f"Episodic memories:\n{snippets}\n\n"
        "Distilled semantic fact:"
    )
    return _call_claude_haiku(prompt, max_tokens=256)

def summarize_project_cluster_haiku(memories: list) -> str | None:
    """Distill a cluster of project memories into a reference fact using claude-haiku-4-5."""
    if not _haiku_available():
        return None
    snippets = "\n".join([
        f"- [{m['name']}]: {m['content'][:300]}"
        for m in memories[:6]
    ])
    prompt = (
        "You are a knowledge consolidation system. The following project memories "
        "are related operational facts that were repeatedly referenced. "
        "Distill them into a single permanent reference entry (2-4 sentences) "
        "capturing the durable operational knowledge. Omit ephemeral dates, "
        "in-progress status, and transient context.\n\n"
        f"Project memories:\n{snippets}\n\n"
        "Consolidated reference fact:"
    )
    return _call_claude_haiku(prompt, max_tokens=300)

# ── Memory write (direct Supabase — MCP server speaks JSON-RPC, not REST) ─────
def write_semantic_memory(name: str, description: str, content: str, tags: list) -> str | None:
    try:
        return upsert_memory_by_name({
            "type": "semantic",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "claude-code",
            "importance_score": 0.75,
        })
    except Exception as e:
        log.error(f"Supabase write failed: {e}")
    return None

def link_target_is_live(target_id: str) -> bool:
    """True if target_id is an ACTIVE memory row.

    The backflow invariant ('no strong edge may point at a retired row') is
    enforced at RETIREMENT by supersede_memory (migration 115) and
    retire_cold_memories (migration 148). Both are one-shot: they downweight the
    edges that exist AT THAT MOMENT. Neither can defend against an edge minted
    LATER, and this script's cluster fetches did not filter is_active, so it
    routinely linked to rows that had already been superseded days earlier
    (62 such edges as of 2026-09-04). Retirement-time downweighting is
    structurally blind to retire-then-link; only a creation-time check closes it.
    """
    try:
        row = supa_get("memories", {"id": f"eq.{target_id}", "select": "is_active", "limit": "1"})
        return bool(row) and row[0].get("is_active") is not False
    except Exception as e:
        # Fail CLOSED: an unverifiable target does not get a strong edge.
        log.warning(f"Liveness check failed for {target_id}, skipping link: {e}")
        return False


def create_link(source_id: str, target_id: str, relationship: str, link_type: str = "semantic"):
    if not link_target_is_live(target_id):
        log.info(f"Skipping link {source_id}->{target_id}: target is retired/inactive")
        return
    try:
        supa_post("memory_links", {
            "source_id": source_id,
            "target_id": target_id,
            "relationship": relationship,
            "link_type": link_type,
            "strength": 0.9,
        })
    except Exception as e:
        log.warning(f"Link creation failed {source_id}->{target_id}: {e}")

def mark_consolidated(memory_id: str, existing_tags: list):
    new_tags = list(set(existing_tags + [CONSOLIDATED_TAG]))
    try:
        supa_patch("memories", {"id": f"eq.{memory_id}"}, {"tags": new_tags})
    except Exception as e:
        log.warning(f"Failed to mark {memory_id} as consolidated: {e}")

def send_discord(msg: str):
    try:
        httpx.post(
            f"{AGENT_BUS_URL}/message",
            json={"text": msg},
            headers={"X-Agent-Secret": AGENT_BUS_SECRET},
            timeout=10,
        )
    except Exception:
        pass


# ── Project memory consolidation ──────────────────────────────────────────────
def fetch_stale_project_memories() -> list:
    """Fetch project memories 7-14 days old with high access_count, not yet consolidated."""
    now = datetime.now(timezone.utc)
    date_min = (now - timedelta(days=PROJECT_AGE_MAX_DAYS)).isoformat()
    date_max = (now - timedelta(days=PROJECT_AGE_MIN_DAYS)).isoformat()
    try:
        mems = supa_get("memories", {
            "type": "eq.project",
            "is_active": "eq.true",
            "access_count": f"gte.{PROJECT_MIN_ACCESS_COUNT}",
            "tags": f"not.cs.{{{CONSOLIDATED_TAG}}}",
            "updated_at": f"gte.{date_min}",
            "select": "id,name,description,content,tags,access_count,embedding,updated_at",
            "order": "access_count.desc",
            "limit": "100",
        })
        # Filter to upper age bound client-side
        mems = [m for m in mems if m.get("updated_at", "") <= date_max]
        return mems
    except Exception as e:
        log.error(f"Failed to fetch stale project memories: {e}")
        return []


def summarize_project_cluster(memories: list) -> str | None:
    """Distill a cluster of related project memories into a permanent reference fact via TRIAGE_MODEL."""
    if not NEMOCLAW_KEY:
        return None

    snippets = "\n".join([
        f"- [{m['name']}]: {m['content'][:300]}"
        for m in memories[:6]
    ])
    prompt = (
        "You are a knowledge consolidation system. The following project memories "
        "are related operational facts that were repeatedly referenced. "
        "Distill them into a single permanent reference entry (2-4 sentences) "
        "capturing the durable operational knowledge. Omit ephemeral dates, "
        "in-progress status, and transient context.\n\n"
        f"Project memories:\n{snippets}\n\n"
        "Consolidated reference fact:"
    )

    try:
        r = httpx.post(
            f"{NEMOCLAW_URL}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {NEMOCLAW_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": TRIAGE_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max(300, NEMOTRON_MIN_MAX_TOKENS),
                "temperature": 0.3,
            },
            timeout=45,
        )
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log.warning(f"LLM project summarization failed: {e}")
    return None


def write_reference_memory(name: str, description: str, content: str, tags: list) -> str | None:
    try:
        return upsert_memory_by_name({
            "type": "reference",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "claude-code",
            "importance_score": 0.80,
        })
    except Exception as e:
        log.error(f"Supabase reference write failed: {e}")
    return None


def run_project_consolidation(use_nemoclaw: bool, use_haiku: bool) -> tuple[int, int]:
    """Phase 2: consolidate stale project memories into reference memories."""
    memories = fetch_stale_project_memories()
    log.info(f"[Phase 2] Found {len(memories)} stale project memories eligible for consolidation")
    if not memories:
        return 0, 0

    for m in memories:
        emb = m.get("embedding")
        if isinstance(emb, str):
            try:
                m["embedding"] = json.loads(emb)
            except Exception:
                m["embedding"] = None

    clusters = cluster_memories(memories)
    log.info(f"[Phase 2] {len(clusters)} clusters found")

    created = 0
    processed = 0

    for cluster_idxs in clusters[:MAX_CLUSTERS]:
        cluster_mems = [memories[i] for i in cluster_idxs]
        cluster_names = [m["name"] for m in cluster_mems]
        log.info(f"[Phase 2] Consolidating {len(cluster_mems)}: {cluster_names[:3]}...")

        # NemoClaw > Haiku > heuristic
        content = summarize_project_cluster(cluster_mems) if use_nemoclaw else None
        if not content and use_haiku:
            content = summarize_project_cluster_haiku(cluster_mems)
        if not content:
            content = summarize_cluster_heuristic(cluster_mems)

        ref_name = cluster_ref_name(cluster_mems, "ref")
        description = f"Consolidated from {len(cluster_mems)} project memories"
        tags = ["auto-consolidated", "project-distilled"] + [
            t for m in cluster_mems for t in (m.get("tags") or [])
            if t not in (CONSOLIDATED_TAG, "auto-consolidated", "project-distilled")
        ][:8]

        ref_id = write_reference_memory(ref_name, description, content, tags)
        if not ref_id:
            log.error(f"[Phase 2] Failed to create reference for {cluster_names}")
            continue

        if ref_id == "ok":
            result = supa_get("memories", {"name": f"eq.{ref_name}", "is_active": "eq.true", "select": "id"})
            ref_id = result[0]["id"] if result else None

        if ref_id:
            for ep_mem in cluster_mems:
                create_link(ref_id, ep_mem["id"], "refines", "semantic")
            for ep_mem in cluster_mems:
                mark_consolidated(ep_mem["id"], ep_mem.get("tags") or [])
            created += 1
            log.info(f"[Phase 2]   ✓ Created reference memory '{ref_name}'")
        else:
            log.warning(f"[Phase 2]   ✗ Could not retrieve ID for '{ref_name}'")
        processed += 1

    return created, processed


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    load_env()

    # Re-read env after loading .env
    global SUPABASE_KEY, NEMOCLAW_KEY, ANTHROPIC_API_KEY
    SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", SUPABASE_KEY)
    NEMOCLAW_KEY = os.environ.get("NVIDIA_API_KEY", "")
    if not NEMOCLAW_KEY:
        try:
            key_path = os.path.expanduser("~/.nvidia_api_key")
            if os.path.exists(key_path):
                NEMOCLAW_KEY = open(key_path).read().strip()
        except Exception:
            pass
    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY)

    log.info("=== Episodic→Semantic distillation started ===")
    start = datetime.now(timezone.utc)

    # 1. Fetch high-access memories eligible for consolidation
    # Phase 0: pure episodic type memories (any access count, older than 6h)
    episodic_cutoff = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
    try:
        episodic_memories = supa_get("memories", {
            "type": "eq.episodic",
            "is_active": "eq.true",
            # Overlap-exclude BOTH tag dialects: this script's 'consolidated' and the
            # legacy consolidate_episodic_memories.py 'consolidated=true' — the two
            # jobs were blind to each other's done-markers (double-processing risk).
            "tags": f"not.ov.{{{CONSOLIDATED_TAG},consolidated=true}}",
            "created_at": f"lt.{episodic_cutoff}",
            "select": "id,name,description,content,tags,access_count,embedding",
            "order": "created_at.asc",
            "limit": "200",
        })
    except Exception as e:
        log.warning(f"Failed to fetch episodic type memories: {e}")
        episodic_memories = []

    # Phase 1: high-access project/feedback/reference memories
    # Target project/feedback/reference — these are used as the primary az-lab types.
    # Episodic type memories are handled in Phase 0 above.
    try:
        memories = supa_get("memories", {
            "type": "in.(project,feedback,reference)",
            "is_active": "eq.true",
            "access_count": f"gte.{MIN_ACCESS_COUNT}",
            "tags": f"not.cs.{{{CONSOLIDATED_TAG}}}",
            "select": "id,name,description,content,tags,access_count,embedding",
            "order": "access_count.desc",
            "limit": "200",
        })
    except Exception as e:
        log.error(f"Failed to fetch memories for consolidation: {e}")
        sys.exit(1)

    log.info(f"Found {len(episodic_memories)} pure episodic type memories, {len(memories)} high-access memories for consolidation (access_count>={MIN_ACCESS_COUNT})")

    use_nemoclaw = bool(NEMOCLAW_KEY)
    use_haiku = _haiku_available() and not use_nemoclaw
    use_llm = use_nemoclaw or use_haiku
    if use_nemoclaw:
        llm_status = f"NemoClaw[{TRIAGE_MODEL}]"
    elif use_haiku:
        llm_status = f"claude-haiku-4-5"
    else:
        llm_status = "heuristic"
    log.info(f"Summarization mode: {llm_status}")

    # ── Phase 0: Consolidate pure episodic type memories → semantic ──────────
    p0_created = 0
    if episodic_memories:
        log.info(f"=== Phase 0: Pure episodic type consolidation ({len(episodic_memories)} memories) ===")
        for m in episodic_memories:
            emb = m.get("embedding")
            if isinstance(emb, str):
                try:
                    m["embedding"] = json.loads(emb)
                except Exception:
                    m["embedding"] = None

        ep_clusters = cluster_memories(episodic_memories)
        # If no clusters (no embeddings), treat all as one batch
        if not ep_clusters and episodic_memories:
            log.info(f"[Phase 0] No embedding-based clusters — batch consolidating {len(episodic_memories)} episodic memories")
            # Process in batches of 10
            for i in range(0, len(episodic_memories), 10):
                batch = episodic_memories[i:i+10]
                content = None
                if use_nemoclaw:
                    content = summarize_cluster_llm(batch)
                if not content and use_haiku:
                    content = summarize_cluster_haiku(batch)
                if not content:
                    content = summarize_cluster_heuristic(batch)
                sem_name = cluster_ref_name(batch, "semantic")
                sem_id = write_semantic_memory(sem_name,
                    f"Distilled from {len(batch)} episodic memories ({llm_status})",
                    content, ["distilled", "episodic-origin"])
                if sem_id:
                    if sem_id == "ok":
                        result = supa_get("memories", {"name": f"eq.{sem_name}", "is_active": "eq.true", "select": "id"})
                        sem_id = result[0]["id"] if result else None
                    if sem_id:
                        for ep in batch:
                            create_link(sem_id, ep["id"], "refines", "semantic")
                        for ep in batch:
                            mark_consolidated(ep["id"], ep.get("tags") or [])
                        p0_created += 1
                        log.info(f"[Phase 0] Created '{sem_name}' from {len(batch)} episodic memories")
        else:
            log.info(f"[Phase 0] {len(ep_clusters)} clusters found")
            for cluster_idxs in ep_clusters[:MAX_CLUSTERS]:
                cluster_mems = [episodic_memories[i] for i in cluster_idxs]
                content = None
                if use_nemoclaw:
                    content = summarize_cluster_llm(cluster_mems)
                if not content and use_haiku:
                    content = summarize_cluster_haiku(cluster_mems)
                if not content:
                    content = summarize_cluster_heuristic(cluster_mems)
                sem_name = cluster_ref_name(cluster_mems, "semantic")
                sem_id = write_semantic_memory(sem_name,
                    f"Distilled from {len(cluster_mems)} episodic memories ({llm_status})",
                    content, ["distilled", "episodic-origin"])
                if sem_id:
                    if sem_id == "ok":
                        result = supa_get("memories", {"name": f"eq.{sem_name}", "is_active": "eq.true", "select": "id"})
                        sem_id = result[0]["id"] if result else None
                    if sem_id:
                        for ep in cluster_mems:
                            create_link(sem_id, ep["id"], "refines", "semantic")
                        for ep in cluster_mems:
                            mark_consolidated(ep["id"], ep.get("tags") or [])
                        p0_created += 1
                        log.info(f"[Phase 0] Created '{sem_name}' from {len(cluster_mems)} episodic memories")
        log.info(f"=== Phase 0 complete: {p0_created} semantic memories created from episodic ===")
    else:
        log.info("[Phase 0] No pure episodic type memories to process.")

    if not memories:
        log.info("[Phase 1] Nothing to distill.")
    else:
        # Parse embeddings from string if needed
        for m in memories:
            emb = m.get("embedding")
            if isinstance(emb, str):
                try:
                    m["embedding"] = json.loads(emb)
                except Exception:
                    m["embedding"] = None

    # 2. Cluster by semantic similarity
    clusters = cluster_memories(memories) if memories else []
    log.info(f"Found {len(clusters)} clusters of related episodic memories")

    # Process up to MAX_CLUSTERS clusters
    processed = 0
    created_semantic = 0

    for cluster_idxs in clusters[:MAX_CLUSTERS]:
        cluster_mems = [memories[i] for i in cluster_idxs]
        cluster_names = [m["name"] for m in cluster_mems]
        log.info(f"Distilling cluster of {len(cluster_mems)}: {cluster_names[:3]}...")

        # 3. Summarize cluster — NemoClaw > Haiku > heuristic
        content = None
        if use_nemoclaw:
            content = summarize_cluster_llm(cluster_mems)
        if not content and use_haiku:
            content = summarize_cluster_haiku(cluster_mems)
        if not content:
            content = summarize_cluster_heuristic(cluster_mems)

        # Generate semantic memory name from top memory
        semantic_name = cluster_ref_name(cluster_mems, "semantic")
        description = f"Distilled from {len(cluster_mems)} episodic memories ({llm_status})"
        tags = ["distilled", "auto-consolidated"] + [
            t for m in cluster_mems for t in (m.get("tags") or [])
            if t not in (CONSOLIDATED_TAG, "distilled", "auto-consolidated")
        ][:8]

        # 4. Insert semantic memory (via MCP → benefits from NOOP/dedup)
        semantic_id = write_semantic_memory(semantic_name, description, content, tags)
        if not semantic_id:
            log.error(f"Failed to create semantic memory for cluster: {cluster_names}")
            continue

        # 5. Get the newly created memory's ID if we got "ok" back
        if semantic_id == "ok":
            result = supa_get("memories", {"name": f"eq.{semantic_name}", "is_active": "eq.true", "select": "id"})
            semantic_id = result[0]["id"] if result else None

        if semantic_id:
            # Create semantic→episodic links
            for ep_mem in cluster_mems:
                create_link(semantic_id, ep_mem["id"], "refines", "semantic")

            # 6. Mark episodic memories as consolidated
            for ep_mem in cluster_mems:
                mark_consolidated(ep_mem["id"], ep_mem.get("tags") or [])

            created_semantic += 1
            log.info(f"  ✓ Created semantic memory '{semantic_name}' from {len(cluster_mems)} episodes")
        else:
            log.warning(f"  ✗ Could not retrieve ID for '{semantic_name}'")

        processed += 1

    elapsed1 = (datetime.now(timezone.utc) - start).total_seconds()
    log.info(f"=== Phase 1 complete: {created_semantic}/{processed} clusters → semantic memories ({elapsed1:.1f}s) ===")

    # ── Phase 2: Project memory consolidation ────────────────────────────────
    log.info("=== Phase 2: Project memory consolidation started ===")
    p2_created, p2_processed = run_project_consolidation(use_nemoclaw, use_haiku)
    elapsed2 = (datetime.now(timezone.utc) - start).total_seconds() - elapsed1

    log.info(f"=== Phase 2 complete: {p2_created}/{p2_processed} clusters → reference memories ({elapsed2:.1f}s) ===")

    # ── Phase 4: Staleness sweep ─────────────────────────────────────────────
    # (Phase 3 is the weekly 30-day consolidation, run from --weekly.)
    log.info("=== Phase 4: Staleness sweep started ===")
    stale_changed, stale_total = run_staleness_sweep()

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    log.info(f"=== Total: {p0_created + created_semantic + p2_created} new memories created in {elapsed:.1f}s ===")

    total_created = p0_created + created_semantic + p2_created
    if total_created > 0:
        p0_note = f"{p0_created} semantic from episodic-type" if p0_created > 0 else ""
        ep_note = f"{created_semantic} semantic from high-access" if created_semantic > 0 else ""
        pr_note = f"{p2_created} reference from project" if p2_created > 0 else ""
        parts = [p for p in [p0_note, ep_note, pr_note] if p]
        if stale_changed:
            parts.append(f"{stale_changed} staleness flag change(s), {stale_total} flagged")
        send_discord(
            f"🧠 Memory consolidation: {', '.join(parts)} "
            f"({llm_status}, {elapsed:.0f}s)"
        )


def run_staleness_sweep() -> tuple[int, int]:
    """Materialize the staleness rule into staleness_candidate (migrations 057/060/085).

    Delegates the whole rule to flag_stale_memories() so this job and the 24h
    startStalenessJob in src/index.ts cannot drift apart. Returns
    (rows_changed, total_currently_flagged).

    Since migration 085 the rule itself lives in memory_is_stale(), and
    stale_memories_review_queue derives membership from it directly rather than
    reading the column this writes. So a lapse here degrades only recall's
    confidence haircut and +stale label — never the review queue's correctness.
    An agent clears a row by stamping verified_at (update_memory_verified() or a
    direct UPDATE both work).
    """
    try:
        result = supa_post("rpc/flag_stale_memories", {})
        changed = result if isinstance(result, int) else 0
    except Exception as e:
        log.warning(f"[Phase 4] staleness sweep failed: {e}")
        return 0, 0

    try:
        flagged = supa_get("memories", {"staleness_candidate": "eq.true", "select": "name"})
        total = len(flagged)
    except Exception:
        total = 0

    log.info(f"=== Phase 4 complete: {changed} flag change(s), {total} memories now flagged stale ===")
    return changed, total


# ── Phase 3: Weekly 30-day project consolidation → reference/consolidation ────
def fetch_project_30day_memories() -> list:
    """Fetch project memories from the last 30 days, not yet auto-consolidated."""
    now = datetime.now(timezone.utc)
    date_cutoff = (now - timedelta(days=WEEKLY_LOOKBACK_DAYS)).isoformat()
    try:
        mems = supa_get("memories", {
            "type": "eq.project",
            "is_active": "eq.true",
            "tags": f"not.cs.{{auto-consolidated}}",
            "updated_at": f"gte.{date_cutoff}",
            "select": "id,name,description,content,tags,access_count,embedding,updated_at",
            "order": "access_count.desc",
            "limit": "200",
        })
        return mems
    except Exception as e:
        log.error(f"[Phase 3] Failed to fetch 30-day project memories: {e}")
        return []


def write_consolidation_memory(name: str, description: str, content: str, tags: list) -> str | None:
    try:
        return upsert_memory_by_name({
            "type": "reference",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "consolidation",
            "importance_score": 0.80,
        })
    except Exception as e:
        log.error(f"[Phase 3] Supabase write failed: {e}")
    return None


def run_weekly_consolidation(use_nemoclaw: bool, use_haiku: bool) -> tuple[int, int]:
    """Phase 3: weekly sweep of 30-day project memories → reference with source=consolidation."""
    memories = fetch_project_30day_memories()
    log.info(f"[Phase 3] Found {len(memories)} project memories in last {WEEKLY_LOOKBACK_DAYS} days")
    if not memories:
        return 0, 0

    for m in memories:
        emb = m.get("embedding")
        if isinstance(emb, str):
            try:
                m["embedding"] = json.loads(emb)
            except Exception:
                m["embedding"] = None

    clusters = cluster_memories(memories)
    log.info(f"[Phase 3] {len(clusters)} semantic clusters found")

    created = 0
    processed = 0
    window_end = datetime.now(timezone.utc).date().isoformat()

    for cluster_idxs in clusters[:MAX_CLUSTERS]:
        cluster_mems = [memories[i] for i in cluster_idxs]
        cluster_names = [m["name"] for m in cluster_mems]
        log.info(f"[Phase 3] Consolidating {len(cluster_mems)}: {cluster_names[:3]}...")

        content = summarize_project_cluster(cluster_mems) if use_nemoclaw else None
        if not content and use_haiku:
            content = summarize_project_cluster_haiku(cluster_mems)
        if not content:
            content = summarize_cluster_heuristic(cluster_mems)

        ref_name = cluster_ref_name(cluster_mems)
        description = (
            f"Weekly consolidation of {len(cluster_mems)} project memories "
            f"({WEEKLY_LOOKBACK_DAYS}-day window ending {window_end})"
        )
        tags = ["auto-consolidated", "weekly-consolidated"] + [
            t for m in cluster_mems for t in (m.get("tags") or [])
            if t not in (CONSOLIDATED_TAG, "auto-consolidated", "weekly-consolidated")
        ][:8]

        ref_id = write_consolidation_memory(ref_name, description, content, tags)
        if not ref_id:
            log.error(f"[Phase 3] Failed to create reference for {cluster_names}")
            continue

        if ref_id == "ok":
            result = supa_get("memories", {"name": f"eq.{ref_name}", "is_active": "eq.true", "select": "id"})
            ref_id = result[0]["id"] if result else None

        if ref_id:
            for m in cluster_mems:
                create_link(ref_id, m["id"], "refines", "semantic")
            for m in cluster_mems:
                mark_consolidated(m["id"], m.get("tags") or [])
            created += 1
            log.info(f"[Phase 3]   ✓ Created reference memory '{ref_name}'")
        else:
            log.warning(f"[Phase 3]   ✗ Could not retrieve ID for '{ref_name}'")
        processed += 1

    return created, processed


def main_weekly():
    """Entry point for --weekly mode: Phase 3 only."""
    load_env()

    global SUPABASE_KEY, NEMOCLAW_KEY, ANTHROPIC_API_KEY
    SUPABASE_KEY = os.environ.get("SUPABASE_SECRET_KEY", SUPABASE_KEY)
    NEMOCLAW_KEY = os.environ.get("NVIDIA_API_KEY", "")
    if not NEMOCLAW_KEY:
        try:
            key_path = os.path.expanduser("~/.nvidia_api_key")
            if os.path.exists(key_path):
                NEMOCLAW_KEY = open(key_path).read().strip()
        except Exception:
            pass
    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY)

    log.info("=== Weekly 30-day project consolidation started ===")
    start = datetime.now(timezone.utc)

    use_nemoclaw = bool(NEMOCLAW_KEY)
    use_haiku = _haiku_available() and not use_nemoclaw
    llm_status = f"NemoClaw[{TRIAGE_MODEL}]" if use_nemoclaw else ("claude-haiku-4-5" if use_haiku else "heuristic")
    log.info(f"Summarization mode: {llm_status}")

    created, processed = run_weekly_consolidation(use_nemoclaw, use_haiku)
    elapsed = (datetime.now(timezone.utc) - start).total_seconds()

    log.info(f"=== Weekly Phase 3 complete: {created}/{processed} clusters → reference memories ({elapsed:.1f}s) ===")

    if created > 0:
        send_discord(
            f"🧠 Weekly memory consolidation: {created} reference memories from {processed} project clusters "
            f"(30-day window, {llm_status}, {elapsed:.0f}s)"
        )


if __name__ == "__main__":
    if "--weekly" in sys.argv:
        main_weekly()
    else:
        main()
