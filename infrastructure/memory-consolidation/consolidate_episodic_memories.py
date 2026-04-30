#!/usr/bin/env python3
"""
Episodic-to-Semantic Memory Consolidation
==========================================
Daily job (04:00 UTC) that promotes high-access episodic memories into
the durable semantic layer shared by Wren, Iris, and Atlas.

Based on CraniMem, ElephantBroker, and Synapse papers (az-lab research 2026-03-29).

Algorithm:
  1. Fetch episodic memories with access_count >= 3, excluding already-consolidated
  2. Cluster by shared tags (greedy); untagged memories batched in groups of 5
  3. For each cluster with 2+ members, call Claude to abstract stable semantic facts
  4. Insert new memories as type='semantic', importance_score=0.75
  5. Add Zettelkasten 'causal' links: semantic -> each source episode
  6. Tag source episodes with 'consolidated=true'
  7. Log summary and send Discord notification

Usage:
  ./consolidate_episodic_memories.py           # normal run
  ./consolidate_episodic_memories.py --dry-run  # preview without writing
"""

import os
import sys
import json
import time
import uuid
import urllib.request
import urllib.error
from urllib.parse import urlencode
from datetime import datetime, timezone

# ── Config ─────────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ogqjjlbupqnvlcyrfnxi.supabase.co")
MEMORY_MCP_ENV = os.path.expanduser("~/azlab/services/memory-mcp-server/.env")
DISCORD_WEBHOOK_FILE = os.path.expanduser("~/claude/agent-bus/discord_webhooks.json")
LOG_FILE = os.path.expanduser("~/azlab/infrastructure/memory-consolidation/consolidate.log")

MIN_ACCESS_COUNT = 3
BATCH_LIMIT = 50
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
SEMANTIC_IMPORTANCE = 0.75  # higher than default 0.5 — semantic facts should persist
DRY_RUN = "--dry-run" in sys.argv


# ── Environment loading ────────────────────────────────────────────────────────

def load_env_file(path):
    env = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_credentials():
    env = load_env_file(MEMORY_MCP_ENV)
    service_key = env.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SECRET_KEY", "")
    api_key = env.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY", "")
    if not service_key:
        raise RuntimeError(f"SUPABASE_SECRET_KEY not found in {MEMORY_MCP_ENV} or environment")
    if not api_key:
        raise RuntimeError(f"ANTHROPIC_API_KEY not found in {MEMORY_MCP_ENV} or environment")
    return service_key, api_key


# ── Supabase REST helpers ──────────────────────────────────────────────────────

def sb_request(service_key, method, path, params=None, body=None, extra_headers=None):
    url = f"{SUPABASE_URL}{path}"
    if params:
        url += "?" + urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        raise RuntimeError(f"Supabase {method} {path} → HTTP {e.code}: {body_text}")


def fetch_episodic_memories(service_key):
    """Fetch episodic memories with access_count >= MIN_ACCESS_COUNT, not yet consolidated."""
    rows = sb_request(service_key, "GET", "/rest/v1/memories", params={
        "type": "eq.episodic",
        "access_count": f"gte.{MIN_ACCESS_COUNT}",
        "select": "id,name,description,content,tags,access_count,importance_score",
        "order": "access_count.desc",
        "limit": str(BATCH_LIMIT),
    })
    # Exclude already-consolidated ones
    return [r for r in rows if "consolidated=true" not in (r.get("tags") or [])]


def insert_semantic_memory(service_key, name, description, content, source_tags):
    """Insert a new semantic memory. Returns the inserted row (with id)."""
    # Merge source tags + 'semantic_consolidation' for traceability
    tags = list(set(source_tags + ["semantic_consolidation"]))
    row = {
        "name": name,
        "type": "semantic",
        "description": description,
        "content": content,
        "tags": tags,
        "source": "memory-consolidation",
        "importance_score": SEMANTIC_IMPORTANCE,
        "access_count": 0,
    }
    result = sb_request(service_key, "POST", "/rest/v1/memories", body=row)
    return result[0] if isinstance(result, list) else result


def add_zettelkasten_link(service_key, source_id, target_id):
    """Add a causal Zettelkasten link: semantic memory -> source episode."""
    link = {
        "source_id": source_id,
        "target_id": target_id,
        "relationship": "causes",
        "link_type": "causal",
        "strength": 0.9,
    }
    sb_request(service_key, "POST", "/rest/v1/memory_links", body=link,
               extra_headers={"Prefer": "resolution=merge-duplicates,return=representation"})


def mark_consolidated(service_key, memory_id, current_tags):
    """Append 'consolidated=true' tag to a source episode."""
    new_tags = list(set((current_tags or []) + ["consolidated=true"]))
    sb_request(service_key, "PATCH", "/rest/v1/memories",
               params={"id": f"eq.{memory_id}"},
               body={"tags": new_tags})


# ── Claude abstraction ─────────────────────────────────────────────────────────

def call_claude(api_key, prompt):
    """Call the Claude API. Returns the response text."""
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read().decode())
    return result["content"][0]["text"]


def abstract_cluster(api_key, cluster):
    """Ask Claude to derive semantic facts from a cluster of episodic memories."""
    summaries = []
    for m in cluster:
        summaries.append({
            "name": m["name"],
            "description": m.get("description", ""),
            "access_count": m.get("access_count", 0),
            "tags": m.get("tags") or [],
            "content": (m.get("content") or "")[:600],
        })

    prompt = f"""You are analyzing episodic interaction records from an AI homelab assistant system to extract stable semantic facts.

Below are {len(cluster)} episodic memories. Each has a name, description, access_count (recall frequency), tags, and content snippet.

Your task: identify recurring patterns and produce 1-3 concise semantic memories — stable, generalized facts abstracted from multiple episodes. A semantic memory captures what is reliably and durably true across multiple interactions, not a single event.

Rules:
- Only create a semantic memory if 2+ episodes support the same underlying pattern
- Content must be factual, stable, and generalized (not tied to a single date/event)
- Keep content concise (2-4 sentences)
- importance_score: 0.65-0.85 based on how fundamental the fact is
- source_memory_names: names of the episodes this fact is abstracted from
- name must start with "semantic_" and use snake_case slug

Respond ONLY with valid JSON — no markdown fences, no extra text:
{{"semantic_memories": [{{"name": "semantic_<slug>", "description": "One-line description", "content": "Full stable content.", "importance_score": 0.75, "source_memory_names": ["ep1", "ep2"]}}]}}

If no clear cross-episode patterns exist, return: {{"semantic_memories": []}}

Episodic memories:
{json.dumps(summaries, indent=2)}"""

    response_text = call_claude(api_key, prompt)

    # Strip markdown fences if Claude added them anyway
    text = response_text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0].strip()

    return json.loads(text)


# ── Clustering ─────────────────────────────────────────────────────────────────

def cluster_by_tags(memories):
    """
    Greedy tag-based clustering.
    - Memories sharing >= 1 tag are grouped together.
    - Untagged memories are batched in groups of 5.
    Returns list of clusters (each a list of memory dicts).
    Only clusters with 2+ members are returned (singletons discarded —
    no cross-episode abstraction possible).
    """
    visited = set()
    tagged_clusters = []

    for mem in memories:
        if mem["id"] in visited:
            continue
        mem_tags = set(t for t in (mem.get("tags") or [])
                       if t not in ("consolidated=true", "semantic_consolidation"))
        if not mem_tags:
            continue  # handle untagged separately

        cluster = [mem]
        visited.add(mem["id"])

        for other in memories:
            if other["id"] in visited:
                continue
            other_tags = set(t for t in (other.get("tags") or [])
                             if t not in ("consolidated=true", "semantic_consolidation"))
            if mem_tags & other_tags:
                cluster.append(other)
                visited.add(other["id"])

        if len(cluster) >= 2:
            tagged_clusters.append(cluster)

    # Untagged memories: batch into groups of 5
    untagged = [m for m in memories if m["id"] not in visited]
    for i in range(0, len(untagged), 5):
        batch = untagged[i:i + 5]
        if len(batch) >= 2:
            tagged_clusters.append(batch)

    return tagged_clusters


# ── Discord notification ───────────────────────────────────────────────────────

def discord_notify(message):
    try:
        if not os.path.exists(DISCORD_WEBHOOK_FILE):
            return
        with open(DISCORD_WEBHOOK_FILE) as f:
            hooks = json.load(f)
        url = hooks.get("claude-code") or hooks.get("default") or next(iter(hooks.values()), None)
        if not url:
            return
        body = json.dumps({"content": message}).encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass  # non-fatal


# ── Logging ────────────────────────────────────────────────────────────────────

def log(message):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {message}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if DRY_RUN:
        log("DRY RUN mode — no writes will occur")

    # Load credentials
    try:
        service_key, api_key = get_credentials()
    except RuntimeError as e:
        log(f"ERROR: {e}")
        sys.exit(1)

    # 1. Fetch eligible episodic memories
    log(f"Fetching episodic memories (access_count >= {MIN_ACCESS_COUNT}, limit {BATCH_LIMIT})")
    try:
        episodes = fetch_episodic_memories(service_key)
    except Exception as e:
        log(f"ERROR fetching episodic memories: {e}")
        sys.exit(1)

    if not episodes:
        log("No eligible episodic memories found — nothing to consolidate")
        discord_notify("🧠 Memory consolidation: no eligible episodic memories (access_count < 3 or all already consolidated)")
        return

    log(f"Found {len(episodes)} eligible episodic memories")

    # 2. Cluster by tags
    clusters = cluster_by_tags(episodes)
    log(f"Formed {len(clusters)} clusters with 2+ members")

    if not clusters:
        log("No multi-member clusters — not enough tag overlap for abstraction")
        discord_notify(f"🧠 Memory consolidation: {len(episodes)} episodic memories found but no clusters formed (insufficient tag overlap)")
        return

    # 3-6. Process each cluster
    total_semantic = 0
    total_links = 0
    total_tagged = 0
    errors = []

    for i, cluster in enumerate(clusters):
        cluster_tags = list(set(
            t for m in cluster
            for t in (m.get("tags") or [])
            if t not in ("consolidated=true", "semantic_consolidation")
        ))
        log(f"Cluster {i+1}/{len(clusters)}: {len(cluster)} episodes, tags={cluster_tags[:5]}")

        # 3. Abstract via Claude
        try:
            result = abstract_cluster(api_key, cluster)
        except Exception as e:
            msg = f"Claude abstraction failed for cluster {i+1}: {e}"
            log(f"WARNING: {msg}")
            errors.append(msg)
            continue

        semantics = result.get("semantic_memories", [])
        if not semantics:
            log(f"  Claude found no cross-episode patterns in cluster {i+1} — skipping")
            continue

        log(f"  Claude derived {len(semantics)} semantic fact(s)")

        # Build name->id lookup for source linking
        name_to_id = {m["name"]: m["id"] for m in cluster}

        for sem in semantics:
            sem_name = sem.get("name", f"semantic_{uuid.uuid4().hex[:8]}")
            sem_desc = sem.get("description", "")
            sem_content = sem.get("content", "")
            sem_importance = float(sem.get("importance_score", SEMANTIC_IMPORTANCE))
            source_names = sem.get("source_memory_names", [])

            if not sem_content:
                log(f"  SKIP: empty content for {sem_name}")
                continue

            if DRY_RUN:
                log(f"  [DRY-RUN] Would insert semantic: {sem_name!r}")
                log(f"    Sources: {source_names}")
                total_semantic += 1
                continue

            # 4. Insert semantic memory
            try:
                new_row = insert_semantic_memory(
                    service_key, sem_name, sem_desc, sem_content,
                    source_tags=cluster_tags
                )
                new_id = new_row.get("id") if isinstance(new_row, dict) else None
                log(f"  Inserted semantic: {sem_name} (id={new_id})")
                total_semantic += 1
            except Exception as e:
                msg = f"Insert failed for {sem_name}: {e}"
                log(f"  ERROR: {msg}")
                errors.append(msg)
                continue

            if not new_id:
                log(f"  WARNING: no id returned for {sem_name} — skipping links")
                continue

            # 5. Add Zettelkasten links: new_semantic -> source_episodes
            for src_name in source_names:
                src_id = name_to_id.get(src_name)
                if not src_id:
                    log(f"  WARNING: source episode {src_name!r} not found in cluster — skipping link")
                    continue
                try:
                    add_zettelkasten_link(service_key, new_id, src_id)
                    log(f"  Link: {sem_name} → {src_name} (causal)")
                    total_links += 1
                except Exception as e:
                    log(f"  WARNING: link insert failed ({sem_name} → {src_name}): {e}")

        # 6. Tag source episodes as consolidated
        if not DRY_RUN:
            for mem in cluster:
                try:
                    mark_consolidated(service_key, mem["id"], mem.get("tags") or [])
                    total_tagged += 1
                except Exception as e:
                    log(f"  WARNING: tag update failed for {mem['name']}: {e}")

        # Throttle between Claude calls to avoid rate limits
        if i < len(clusters) - 1:
            time.sleep(1)

    # Summary
    summary = (
        f"Memory consolidation complete: "
        f"{len(episodes)} episodic memories → "
        f"{total_semantic} semantic facts, "
        f"{total_links} Zettelkasten links, "
        f"{total_tagged} episodes tagged 'consolidated=true'"
    )
    if errors:
        summary += f" | {len(errors)} errors"
    log(summary)

    emoji = "✅" if not errors else "⚠️"
    discord_notify(f"{emoji} 🧠 {summary}")

    if errors:
        log("Errors encountered:")
        for err in errors:
            log(f"  - {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
