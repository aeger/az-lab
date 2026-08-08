#!/usr/bin/env python3
"""
TEI-compatible /rerank over an ONNX INT8 cross-encoder.

WHY A SHIM AND NOT JUST TEI
  TEI's CPU image runs Candle, not ONNX Runtime, so it cannot serve a quantized
  ONNX artifact. Rather than fork TEI, this exposes the two endpoints
  eval/rerank_ab.py already speaks — GET /info and POST /rerank — so the INT8
  model drops into the EXISTING multi-arm harness as just another `--arm
  name=url`. Nothing about the A/B method changes, which is the point: the
  comparison stays apples-to-apples with the arms already measured.

CONTRACT (matched to TEI 1.9.3, which is what az-tei-reranker serves)
  POST /rerank  {"query": str, "texts": [str], "truncate": bool}
             -> [{"index": int, "score": float}, ...]
  GET  /info    {"model_id": ..., "max_input_length": ..., ...}

  Scores are raw logits, exactly as TEI returns them. The harness sorts by
  -score and only ever uses the ORDER, so no sigmoid is applied — adding one
  would be a monotonic no-op that only made the numbers look different.

THREADING
  intra_op threads default to the container's CPU budget. This is the single
  biggest lever on p50 for a batch-of-20 rerank on a 4-core box, and leaving it
  to the ORT default (which does not see cgroup limits) is how a benchmark ends
  up measuring thread thrash instead of the model.
"""
import os
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoTokenizer

MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/models/int8"))
MODEL_ID = os.environ.get("MODEL_ID", "BAAI/bge-reranker-base (onnx-int8)")
MAX_LEN = int(os.environ.get("MAX_INPUT_LENGTH", "512"))
MAX_BATCH = int(os.environ.get("MAX_CLIENT_BATCH_SIZE", "32"))
THREADS = int(os.environ.get("ORT_THREADS", str(os.cpu_count() or 4)))

_onnx = next(MODEL_DIR.glob("*quantized*.onnx"), None) or next(MODEL_DIR.glob("*.onnx"))

_opts = ort.SessionOptions()
_opts.intra_op_num_threads = THREADS
_opts.inter_op_num_threads = 1
_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

session = ort.InferenceSession(str(_onnx), _opts, providers=["CPUExecutionProvider"])
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
_inputs = {i.name for i in session.get_inputs()}

app = FastAPI()


class RerankRequest(BaseModel):
    query: str
    texts: list[str]
    truncate: bool = True
    raw_scores: bool = False


@app.get("/info")
def info():
    return {
        "model_id": MODEL_ID,
        "model_dtype": "int8",
        "model_type": {"reranker": {"id2label": {"0": "LABEL_0"}}},
        "max_input_length": MAX_LEN,
        "max_client_batch_size": MAX_BATCH,
        "onnx_file": _onnx.name,
        "intra_op_threads": THREADS,
        "version": "onnx-int8-shim/1.0",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/rerank")
def rerank(req: RerankRequest):
    if not req.texts:
        return []
    t0 = time.perf_counter()

    # Cross-encoder: the query is paired with EVERY candidate, so the batch is
    # len(texts) pairs, not one sequence. Padding to the batch max (not to
    # MAX_LEN) is what TEI does and keeps short candidates cheap.
    enc = tokenizer(
        [req.query] * len(req.texts),
        list(req.texts),
        padding=True,
        truncation=req.truncate,
        max_length=MAX_LEN,
        return_tensors="np",
    )
    feed = {k: v.astype(np.int64) for k, v in enc.items() if k in _inputs}
    logits = session.run(None, feed)[0]

    # (n, 1) for a single-logit relevance head; (n, 2) would be a pair classifier
    # where the positive class is index 1.
    scores = logits[:, 0] if logits.shape[-1] == 1 else logits[:, -1]

    out = [{"index": i, "score": float(s)} for i, s in enumerate(scores)]
    out.sort(key=lambda d: -d["score"])
    app.state.last_ms = (time.perf_counter() - t0) * 1000
    return out


if __name__ == "__main__":
    print(f"[serve] {MODEL_ID} from {_onnx} | threads={THREADS} | max_len={MAX_LEN}")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="warning")
