#!/usr/bin/env python3
"""
Episodic → Semantic → Procedural auto-distillation pipeline.

Queries episodic memories with access_count >= 3 (not yet consolidated),
clusters by semantic similarity, distills each cluster into a stable
semantic fact, and inserts as type=semantic with Zettelkasten links
back to the source episodes.

Based on ElephantBroker 3-session promotion threshold and CraniMem
scheduled consolidation replay pattern.

Systemd timer: episodic-distill.timer (nightly at 03:00 UTC)
"""

import os
import sys
import json
import logging
import httpx
import numpy as np
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
SUPABASE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")
MEMORY_MCP_URL = os.environ.get("MEMORY_MCP_URL", "http://localhost:3100")
NEMOCLAW_URL  = os.environ.get("NEMOCLAW_URL", "http://192.168.1.183:8000")
NEMOCLAW_KEY  = os.environ.get("NVIDIA_API_KEY", "")
NEMOCLAW_MODEL = os.environ.get("NEMOCLAW_MODEL", "nvidia/nemotron-3-super-120b-a12b")

MIN_ACCESS_COUNT = int(os.environ.get("MIN_ACCESS_COUNT", "3"))
CLUSTER_THRESHOLD = float(os.environ.get("CLUSTER_THRESHOLD", "0.82"))
MAX_CLUSTERS = int(os.environ.get("MAX_CLUSTERS", "20"))
CONSOLIDATED_TAG = "consolidated"
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

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    load_env()

    # Re-read env after loading .env
    global SUPABASE_KEY, NEMOCLAW_KEY
    SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", SUPABASE_KEY)
    NEMOCLAW_KEY = os.environ.get("NVIDIA_API_KEY", "")
    if not NEMOCLAW_KEY:
        try:
            key_path = os.path.expanduser("~/.nvidia_api_key")
            if os.path.exists(key_path):
                NEMOCLAW_KEY = open(key_path).read().strip()
        except Exception:
            pass

    log.info("=== Episodic→Semantic distillation started ===")
    start = datetime.now(timezone.utc)

    # 1. Fetch episodic memories eligible for consolidation
    try:
        memories = supa_get("memories", {
            "type": "eq.episodic",
            "access_count": f"gte.{MIN_ACCESS_COUNT}",
            "tags": f"not.cs.{{{CONSOLIDATED_TAG}}}",
            "select": "id,name,description,content,tags,access_count,embedding",
            "order": "access_count.desc",
            "limit": "200",
        })
    except Exception as e:
        log.error(f"Failed to fetch episodic memories: {e}")
        sys.exit(1)

    log.info(f"Found {len(memories)} eligible episodic memories (access_count>={MIN_ACCESS_COUNT})")

    if not memories:
        log.info("Nothing to distill.")
        return

    # Parse embeddings from string if needed
    for m in memories:
        emb = m.get("embedding")
        if isinstance(emb, str):
            try:
                m["embedding"] = json.loads(emb)
            except Exception:
                m["embedding"] = None

    # 2. Cluster by semantic similarity
    clusters = cluster_memories(memories)
    log.info(f"Found {len(clusters)} clusters of related episodic memories")

    if not clusters:
        log.info("No clusters formed — all memories are semantically distinct.")
        return

    # Process up to MAX_CLUSTERS clusters
    processed = 0
    created_semantic = 0
    use_llm = bool(NEMOCLAW_KEY)
    llm_status = "NemoClaw" if use_llm else "heuristic"
    log.info(f"Summarization mode: {llm_status}")

    for cluster_idxs in clusters[:MAX_CLUSTERS]:
        cluster_mems = [memories[i] for i in cluster_idxs]
        cluster_names = [m["name"] for m in cluster_mems]
        log.info(f"Distilling cluster of {len(cluster_mems)}: {cluster_names[:3]}...")

        # 3. Summarize cluster
        content = None
        if use_llm:
            content = summarize_cluster_llm(cluster_mems)
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

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    log.info(f"=== Distillation complete: {created_semantic}/{processed} clusters → semantic memories ({elapsed:.1f}s) ===")

    if created_semantic > 0:
        send_discord(
            f"🧠 Episodic distillation: {created_semantic} new semantic memories created "
            f"from {sum(len(clusters[i]) for i in range(min(processed, len(clusters))))} episodic sources "
            f"({llm_status}, {elapsed:.0f}s)"
        )


if __name__ == "__main__":
    main()
