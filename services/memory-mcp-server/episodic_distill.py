#!/usr/bin/env python3
"""
Episodic → Semantic → Procedural auto-distillation pipeline.

Phase 1: Queries episodic memories with access_count >= 3 (not yet consolidated),
clusters by semantic similarity, distills each cluster into a stable
semantic fact, and inserts as type=semantic with Zettelkasten links
back to the source episodes.

Phase 2: Queries project memories 7-14 days old with access_count >= 2 (not yet
consolidated), distills each cluster into a reference memory (permanent
operational knowledge).

Based on ElephantBroker 3-session promotion threshold and CraniMem
scheduled consolidation replay pattern.

LLM priority: NemoClaw (Nemotron 120B, on-prem) > claude-haiku-4-5 (Anthropic API) > heuristic
- NemoClaw: preferred when NVIDIA_API_KEY set (on-prem, no token cost)
- Haiku: fallback when ANTHROPIC_API_KEY set (low-cost cloud, ~$0.25/MTok input)
- Heuristic: always available, no LLM needed

Systemd timer: episodic-distill.timer (nightly at 03:00 UTC)
"""

import os
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
NEMOCLAW_URL  = os.environ.get("NEMOCLAW_URL", "http://192.168.1.183:8000")
NEMOCLAW_KEY  = os.environ.get("NVIDIA_API_KEY", "")
NEMOCLAW_MODEL = os.environ.get("NEMOCLAW_MODEL", "nvidia/nemotron-3-super-120b-a12b")
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
AGENT_BUS_URL = "http://localhost:8765"

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
    """Try to summarize a cluster of episodic memories via NemoClaw."""
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
                "model": NEMOCLAW_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 256,
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

def _call_claude_haiku(prompt: str, max_tokens: int = 256) -> str | None:
    """Call claude-haiku-4-5 via Anthropic Messages API. Returns text or None on failure."""
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
    if not ANTHROPIC_API_KEY:
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
    if not ANTHROPIC_API_KEY:
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

# ── Memory MCP write (via HTTP) ───────────────────────────────────────────────
def write_semantic_memory(name: str, description: str, content: str, tags: list) -> str | None:
    """Write a semantic memory via memory-mcp-server HTTP API."""
    try:
        r = httpx.post(
            f"{MEMORY_MCP_URL}/tools/remember",
            json={
                "type": "semantic",
                "name": name,
                "description": description,
                "content": content,
                "tags": tags,
                "source": "claude-code",
                "importance_score": 0.75,
            },
            timeout=30,
        )
        if r.status_code == 200:
            data = r.json()
            # Extract memory ID from result if available
            return data.get("id") or "ok"
    except Exception as e:
        log.warning(f"MCP write failed, falling back to direct Supabase: {e}")

    # Fallback: direct Supabase insert
    try:
        result = supa_post("memories", {
            "type": "semantic",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "claude-code",
            "importance_score": 0.75,
        })
        if isinstance(result, list) and result:
            return result[0].get("id")
    except Exception as e:
        log.error(f"Direct Supabase write failed: {e}")
    return None

def create_link(source_id: str, target_id: str, relationship: str, link_type: str = "semantic"):
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
            f"{AGENT_BUS_URL}/send-discord",
            json={"channel": DISCORD_CHANNEL, "message": msg},
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
    """Distill a cluster of related project memories into a permanent reference fact."""
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
                "model": NEMOCLAW_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 300,
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
    """Write a reference memory via MCP (with Supabase fallback)."""
    try:
        r = httpx.post(
            f"{MEMORY_MCP_URL}/tools/remember",
            json={
                "type": "reference",
                "name": name,
                "description": description,
                "content": content,
                "tags": tags,
                "source": "claude-code",
                "importance_score": 0.80,
            },
            timeout=30,
        )
        if r.status_code == 200:
            return r.json().get("id") or "ok"
    except Exception as e:
        log.warning(f"MCP reference write failed, falling back to Supabase: {e}")

    try:
        result = supa_post("memories", {
            "type": "reference",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "claude-code",
            "importance_score": 0.80,
        })
        if isinstance(result, list) and result:
            return result[0].get("id")
    except Exception as e:
        log.error(f"Direct Supabase reference write failed: {e}")
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

        top_mem = max(cluster_mems, key=lambda m: m.get("access_count", 0))
        ref_name = f"ref:{top_mem['name']}"
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
            result = supa_get("memories", {"name": f"eq.{ref_name}", "select": "id"})
            ref_id = result[0]["id"] if result else None

        if ref_id:
            for ep_mem in cluster_mems:
                create_link(ref_id, ep_mem["id"], "consolidated_from", "semantic")
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
            "tags": f"not.cs.{{{CONSOLIDATED_TAG}}}",
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
    use_haiku = bool(ANTHROPIC_API_KEY) and not use_nemoclaw
    use_llm = use_nemoclaw or use_haiku
    if use_nemoclaw:
        llm_status = "NemoClaw"
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
                top_mem = max(batch, key=lambda m: m.get("access_count", 0))
                sem_name = f"semantic:{top_mem['name']}"
                sem_id = write_semantic_memory(sem_name,
                    f"Distilled from {len(batch)} episodic memories ({llm_status})",
                    content, ["distilled", "episodic-origin"])
                if sem_id:
                    if sem_id == "ok":
                        result = supa_get("memories", {"name": f"eq.{sem_name}", "select": "id"})
                        sem_id = result[0]["id"] if result else None
                    if sem_id:
                        for ep in batch:
                            create_link(sem_id, ep["id"], "distilled_from", "semantic")
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
                top_mem = max(cluster_mems, key=lambda m: m.get("access_count", 0))
                sem_name = f"semantic:{top_mem['name']}"
                sem_id = write_semantic_memory(sem_name,
                    f"Distilled from {len(cluster_mems)} episodic memories ({llm_status})",
                    content, ["distilled", "episodic-origin"])
                if sem_id:
                    if sem_id == "ok":
                        result = supa_get("memories", {"name": f"eq.{sem_name}", "select": "id"})
                        sem_id = result[0]["id"] if result else None
                    if sem_id:
                        for ep in cluster_mems:
                            create_link(sem_id, ep["id"], "distilled_from", "semantic")
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
        top_mem = max(cluster_mems, key=lambda m: m.get("access_count", 0))
        semantic_name = f"semantic:{top_mem['name']}"
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
            result = supa_get("memories", {"name": f"eq.{semantic_name}", "select": "id"})
            semantic_id = result[0]["id"] if result else None

        if semantic_id:
            # Create semantic→episodic links
            for ep_mem in cluster_mems:
                create_link(semantic_id, ep_mem["id"], "distilled_from", "semantic")

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

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    log.info(f"=== Phase 2 complete: {p2_created}/{p2_processed} clusters → reference memories ({elapsed2:.1f}s) ===")
    log.info(f"=== Total: {p0_created + created_semantic + p2_created} new memories created in {elapsed:.1f}s ===")

    total_created = p0_created + created_semantic + p2_created
    if total_created > 0:
        p0_note = f"{p0_created} semantic from episodic-type" if p0_created > 0 else ""
        ep_note = f"{created_semantic} semantic from high-access" if created_semantic > 0 else ""
        pr_note = f"{p2_created} reference from project" if p2_created > 0 else ""
        parts = [p for p in [p0_note, ep_note, pr_note] if p]
        send_discord(
            f"🧠 Memory consolidation: {', '.join(parts)} "
            f"({llm_status}, {elapsed:.0f}s)"
        )


# ── Phase 3: Weekly 30-day project consolidation → reference/consolidation ────
def fetch_project_30day_memories() -> list:
    """Fetch project memories from the last 30 days, not yet auto-consolidated."""
    now = datetime.now(timezone.utc)
    date_cutoff = (now - timedelta(days=WEEKLY_LOOKBACK_DAYS)).isoformat()
    try:
        mems = supa_get("memories", {
            "type": "eq.project",
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
    """Write a reference memory with source='consolidation' via Supabase."""
    try:
        r = httpx.post(
            f"{MEMORY_MCP_URL}/tools/remember",
            json={
                "type": "reference",
                "name": name,
                "description": description,
                "content": content,
                "tags": tags,
                "source": "consolidation",
                "importance_score": 0.80,
            },
            timeout=30,
        )
        if r.status_code == 200:
            return r.json().get("id") or "ok"
    except Exception as e:
        log.warning(f"[Phase 3] MCP write failed, falling back to Supabase: {e}")

    try:
        result = supa_post("memories", {
            "type": "reference",
            "name": name,
            "description": description,
            "content": content,
            "tags": tags,
            "source": "consolidation",
            "importance_score": 0.80,
        })
        if isinstance(result, list) and result:
            return result[0].get("id")
    except Exception as e:
        log.error(f"[Phase 3] Direct Supabase write failed: {e}")
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

    for cluster_idxs in clusters[:MAX_CLUSTERS]:
        cluster_mems = [memories[i] for i in cluster_idxs]
        cluster_names = [m["name"] for m in cluster_mems]
        log.info(f"[Phase 3] Consolidating {len(cluster_mems)}: {cluster_names[:3]}...")

        content = summarize_project_cluster(cluster_mems) if use_nemoclaw else None
        if not content and use_haiku:
            content = summarize_project_cluster_haiku(cluster_mems)
        if not content:
            content = summarize_cluster_heuristic(cluster_mems)

        top_mem = max(cluster_mems, key=lambda m: m.get("access_count", 0))
        ref_name = f"weekly-ref:{top_mem['name']}"
        description = f"Weekly consolidation of {len(cluster_mems)} project memories (30-day window)"
        tags = ["auto-consolidated", "weekly-consolidated"] + [
            t for m in cluster_mems for t in (m.get("tags") or [])
            if t not in (CONSOLIDATED_TAG, "auto-consolidated", "weekly-consolidated")
        ][:8]

        ref_id = write_consolidation_memory(ref_name, description, content, tags)
        if not ref_id:
            log.error(f"[Phase 3] Failed to create reference for {cluster_names}")
            continue

        if ref_id == "ok":
            result = supa_get("memories", {"name": f"eq.{ref_name}", "select": "id"})
            ref_id = result[0]["id"] if result else None

        if ref_id:
            for m in cluster_mems:
                create_link(ref_id, m["id"], "weekly_consolidated_from", "semantic")
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
    use_haiku = bool(ANTHROPIC_API_KEY) and not use_nemoclaw
    llm_status = "NemoClaw" if use_nemoclaw else ("claude-haiku-4-5" if use_haiku else "heuristic")
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
