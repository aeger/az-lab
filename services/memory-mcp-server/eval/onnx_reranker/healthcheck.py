#!/usr/bin/env python3
"""Container healthcheck for the ONNX INT8 reranker.

WHY A FILE AND NOT AN INLINE `python3 -c` IN compose.yml
  podman-compose flattens a healthcheck `test:` list into a single shell string
  without re-quoting the elements, so any inline Python containing parentheses
  comes back as `/bin/sh: Syntax error: word unexpected (expecting ")")` and the
  container sits in `starting` forever while the service underneath is fine.
  A script path has no shell metacharacters, so it survives the flattening.

  The obvious alternative — `curl -sf localhost:8080/health` — is not available:
  this image is python:3.12-slim with no curl and no wget, and adding one just to
  probe a local port would be a package for a job the stdlib already does.

The probe hits /health rather than /rerank on purpose: /rerank would run a real
cross-encoder forward pass every 30s on a 4-core box that is also serving them.
"""
import sys
import urllib.request

URL = "http://localhost:8080/health"

try:
    with urllib.request.urlopen(URL, timeout=5) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception as e:
    print(f"healthcheck: {e}", file=sys.stderr)
    sys.exit(1)
