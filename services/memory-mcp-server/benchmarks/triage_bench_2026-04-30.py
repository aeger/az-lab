#!/usr/bin/env python3
"""Triage workload benchmark: Gemma 4 31B IT vs Nemotron 120B A12B on NIM API.

Routine triage workloads (memory cluster summarization, classification, short
extraction) — exactly what the consolidation pipeline runs nightly.
"""
import json
import os
import statistics
import time
from pathlib import Path

import requests

NIM = "https://integrate.api.nvidia.com/v1/chat/completions"
KEY = Path("~/.nvidia_api_key").expanduser().read_text().strip()

MODELS = {
    "gemma-4-31b": "google/gemma-4-31b-it",
    "nemotron-120b": "nvidia/nemotron-3-super-120b-a12b",
}

# Real workload samples mirroring consolidation/triage paths.
PROMPTS = [
    {
        "name": "cluster_summarize",
        "system": "Summarize related memories into one concise semantic fact in <=2 sentences. No preamble.",
        "user": (
            "Memories:\n"
            "1. Jeff prefers DD/MM/YYYY date format in dashboard.\n"
            "2. Date format on goals widget changed to DD/MM after Jeff feedback.\n"
            "3. Jeff corrected timestamp display on agent terminal to DD/MM/YYYY.\n"
            "4. Discord notification timestamps adjusted to DD/MM/YYYY format."
        ),
        "max_tokens": 256,
    },
    {
        "name": "triage_classify",
        "system": "Classify the email into exactly one of: junk, news_digest, important, financial, security. Reply with the single label only.",
        "user": (
            "From: alerts@cox.com\n"
            "Subject: Your statement is ready — autopay confirmed\n"
            "Body: Your bill of $129.95 has been paid via autopay. View statement at cox.com/billing."
        ),
        "max_tokens": 256,
    },
    {
        "name": "extract_facts",
        "system": "Extract entities as JSON: {host,ip,role}. Output JSON only.",
        "user": "svc-podman-01 at 192.168.1.181 is the production VM hosting Podman containers and Traefik.",
        "max_tokens": 64,
    },
    {
        "name": "decision_tag",
        "system": "Reply with exactly one tag from: action_required, info_only, follow_up, archive.",
        "user": (
            "Cloudflare cert renewed automatically. ACME DNS-01 succeeded. "
            "No action required. Logged at 2026-04-30T03:14Z."
        ),
        "max_tokens": 256,
    },
    {
        "name": "short_summarize",
        "system": "Summarize in one sentence under 20 words. No preamble.",
        "user": (
            "The MS-01 Proxmox node hosts VMs 107 (Home Assistant), 108 (NemoClaw), and LXC 106 "
            "(game server on VLAN30). ZFS pools nvme-fast and nvme-fast-02 back the VMs."
        ),
        "max_tokens": 256,
    },
]


def call(model_id: str, prompt: dict) -> dict:
    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": prompt["system"]},
            {"role": "user", "content": prompt["user"]},
        ],
        "max_tokens": prompt["max_tokens"],
        "temperature": 0.2,
        "top_p": 0.9,
        "stream": False,
    }
    t0 = time.perf_counter()
    r = requests.post(
        NIM,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        json=body,
        timeout=120,
    )
    dt = time.perf_counter() - t0
    if r.status_code != 200:
        return {"ok": False, "latency_s": dt, "status": r.status_code, "body": r.text[:300]}
    j = r.json()
    msg = j["choices"][0]["message"]
    text = msg.get("content") or ""
    if not text and msg.get("reasoning_content"):
        text = msg["reasoning_content"]
    usage = j.get("usage", {})
    return {
        "ok": True,
        "latency_s": dt,
        "completion_tokens": usage.get("completion_tokens", 0),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "tokens_per_s": (usage.get("completion_tokens", 0) / dt) if dt > 0 else 0,
        "text": text.strip(),
    }


def main():
    results = {}
    for label, mid in MODELS.items():
        print(f"\n=== {label} ({mid}) ===")
        results[label] = []
        for p in PROMPTS:
            # Two runs each, take median, to dampen NIM cold/warm jitter.
            runs = []
            for _ in range(2):
                runs.append(call(mid, p))
                time.sleep(0.2)
            ok_runs = [r for r in runs if r.get("ok")]
            if not ok_runs:
                print(f"  {p['name']}: FAIL {runs[0]}")
                results[label].append({"name": p["name"], "ok": False, "err": runs[0]})
                continue
            best = min(ok_runs, key=lambda r: r["latency_s"])
            results[label].append({"name": p["name"], **best})
            print(
                f"  {p['name']}: {best['latency_s']:.2f}s "
                f"({best['completion_tokens']}t, {best['tokens_per_s']:.1f} t/s) -> {best['text'][:90]!r}"
            )

    # Summary
    print("\n\n=== SUMMARY ===")
    print(f"{'task':<22}{'gemma_s':>10}{'nemo_s':>10}{'speedup':>10}{'gemma_t/s':>12}{'nemo_t/s':>12}")
    for i, p in enumerate(PROMPTS):
        g = results["gemma-4-31b"][i]
        n = results["nemotron-120b"][i]
        if not (g.get("ok") and n.get("ok")):
            continue
        speedup = n["latency_s"] / g["latency_s"]
        print(
            f"{p['name']:<22}{g['latency_s']:>10.2f}{n['latency_s']:>10.2f}"
            f"{speedup:>9.2f}x{g['tokens_per_s']:>12.1f}{n['tokens_per_s']:>12.1f}"
        )

    g_lat = [r["latency_s"] for r in results["gemma-4-31b"] if r.get("ok")]
    n_lat = [r["latency_s"] for r in results["nemotron-120b"] if r.get("ok")]
    g_tps = [r["tokens_per_s"] for r in results["gemma-4-31b"] if r.get("ok")]
    n_tps = [r["tokens_per_s"] for r in results["nemotron-120b"] if r.get("ok")]
    print()
    print(
        f"gemma-4-31b: median latency {statistics.median(g_lat):.2f}s, mean tok/s {statistics.mean(g_tps):.1f}"
    )
    print(
        f"nemotron-120b: median latency {statistics.median(n_lat):.2f}s, mean tok/s {statistics.mean(n_tps):.1f}"
    )

    out = Path("/tmp/triage_bench_2026-04-30.json")
    out.write_text(json.dumps({"models": MODELS, "results": results}, indent=2))
    print(f"\nFull results: {out}")


if __name__ == "__main__":
    main()
