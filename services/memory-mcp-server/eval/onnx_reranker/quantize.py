#!/usr/bin/env python3
"""
Export BAAI/bge-reranker-base to ONNX and dynamically quantize it to INT8.

WHY (2026-08-07 research TIER 2)
  The 2026-08-06 A/B settled the model-size question and closed
  bge-reranker-v2-m3 as won't-fix on CPU: rerank buys nDCG@5 +11.0% and MRR
  +15.3% but recall@5 only +1.3%, at a p50 of 4684ms against a 491ms first
  stage. The first stage is ALREADY finding the right documents; rerank is
  reordering them, and paying ~9.5x the first-stage cost to do it. A HEAVIER
  cross-encoder (v2-m3, 568M vs 278M) spends more of the resource that is
  already the bottleneck to buy more of the metric that is already the cheapest.

  So the lever is the latency of the model that is already deployed. Dynamic
  INT8 is the standard CPU lever for exactly this shape: weights quantized
  ahead of time, activations quantized on the fly, no calibration set needed,
  no GPU anywhere.

  Expect SUB-LINEAR gains. A 4x reduction in arithmetic complexity does not
  produce a 4x latency reduction — memory bandwidth, tokenization, and the
  un-quantized ops in between all stay put. This script's job is to produce the
  artifact; rerank_ab.py's job is to say whether the gain is real on this box.

CHOICES
  avx2, not avx512_vnni: /proc/cpuinfo on svc-podman-01 (i9-13900H) reports
  avx/avx2 and no avx512. Building for an ISA the host does not have silently
  falls back to a slower kernel, which would make the arm look worse than the
  technique actually is.

  per_channel=True: cross-encoder relevance scores are a single logit, so
  per-tensor weight scales put the whole quality budget on one number.
  Per-channel costs nothing at inference and is the difference between "INT8
  held nDCG" and "INT8 lost 3 points for no reason".

USAGE
  python3 quantize.py --out /models      # writes /models/{fp32,int8}
"""
import argparse
import shutil
import time
from pathlib import Path

from optimum.onnxruntime import ORTModelForSequenceClassification, ORTQuantizer
from optimum.onnxruntime.configuration import AutoQuantizationConfig
from transformers import AutoTokenizer

MODEL_ID = "BAAI/bge-reranker-base"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--out", default="/models")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    out = Path(args.out)
    fp32_dir, int8_dir = out / "fp32", out / "int8"

    if int8_dir.joinpath("model_quantized.onnx").exists() and not args.force:
        print(f"[quantize] {int8_dir} already built — skipping (use --force to rebuild)")
        return

    if args.force:
        for d in (fp32_dir, int8_dir):
            shutil.rmtree(d, ignore_errors=True)

    # ── 1. Export to ONNX (fp32) ────────────────────────────────────────────
    t0 = time.time()
    print(f"[quantize] exporting {args.model} -> ONNX fp32 …")
    model = ORTModelForSequenceClassification.from_pretrained(args.model, export=True)
    tok = AutoTokenizer.from_pretrained(args.model)
    fp32_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(fp32_dir)
    tok.save_pretrained(fp32_dir)
    print(f"[quantize] fp32 export done in {time.time() - t0:.0f}s")

    # ── 2. Dynamic INT8 ─────────────────────────────────────────────────────
    t1 = time.time()
    print("[quantize] dynamic INT8 (avx2, per-channel) …")
    quantizer = ORTQuantizer.from_pretrained(fp32_dir)
    qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=True)
    int8_dir.mkdir(parents=True, exist_ok=True)
    quantizer.quantize(save_dir=int8_dir, quantization_config=qconfig)
    tok.save_pretrained(int8_dir)
    print(f"[quantize] INT8 done in {time.time() - t1:.0f}s")

    def mb(p: Path) -> float:
        return sum(f.stat().st_size for f in p.glob("*.onnx")) / 1e6

    print(f"[quantize] fp32 {mb(fp32_dir):.0f} MB -> int8 {mb(int8_dir):.0f} MB")


if __name__ == "__main__":
    main()
