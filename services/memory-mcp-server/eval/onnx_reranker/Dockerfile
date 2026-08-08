# ONNX INT8 reranker arm for eval/rerank_ab.py (2026-08-07 research TIER 2).
#
# CPU-only by construction: onnxruntime (not -gpu), torch pinned to the CPU
# wheel index. The GPU wheels pull ~2.5 GB of CUDA that svc-podman-01 has no
# device for, and would quietly make the image the biggest thing in the stack.
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    TOKENIZERS_PARALLELISM=false

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 \
 && pip install \
      "optimum[onnxruntime]==1.24.0" \
      transformers==4.48.3 \
      onnx==1.17.0 \
      onnxruntime==1.20.1 \
      fastapi==0.115.6 \
      "uvicorn[standard]==0.34.0" \
      numpy

WORKDIR /app
COPY quantize.py serve.py healthcheck.py /app/

# Quantization is a BUILD-TIME-optional / RUN-TIME-idempotent step: the artifact
# lands in the /models volume, so the first `up` pays for it once and every
# later start finds it and skips. Keeping it out of the image layer means the
# image does not have to be rebuilt to re-quantize.
CMD ["sh", "-c", "python3 /app/quantize.py --out /models && python3 /app/serve.py"]
