# container-health — podman healthcheck integrity

## The failure this exists for

On 2026-08-12, four containers on the retrieval path (`az-tei-embed`,
`az-tei-reranker`, `az-rerank-onnx`, `cadvisor-host`) had been sitting in
`Up 19-20 hours (starting)` since the 08-11 19:48Z reboot:

```
"Health": {"Status":"starting","FailingStreak":0,"Log":null}
```

`Log: null` is the whole story — the probe had never produced a single result.
`FailingStreak` therefore could never leave `0`, and **nothing that keys on
`unhealthy` could ever fire**. The services themselves were fine the entire
time (`az-rerank-onnx` was answering 200s on :8088). What was missing was the
*scheduler*.

## Root cause

Podman 4.9.3 runs each container's healthcheck from a **transient systemd timer
named after the container ID**. Two things go wrong with that, and neither
raises anything:

1. **Recreation orphans the timer.** Restart a compose stack and the old
   containers' `<id>.timer` units can outlive them while the *new* containers
   get no timer at all. The stale timers then run
   `podman healthcheck run <dead-id>` every 30s forever, exiting 125 into the
   journal. This was reproduced live on 2026-08-12: a single
   `systemctl --user restart compose-stack@memory-mcp-server` recreated all
   three containers with zero timers and three fresh orphans.

2. **Image-inherited healthchecks are never scheduled.** A `HEALTHCHECK` baked
   into an image populates `.Config.Healthcheck` but gets no timer unless the
   probe is also passed on the podman command line. `cadvisor-host` froze at
   `starting`; `calibre-web-automated` froze at a stale `healthy` — the more
   dangerous direction, because it reads green on every dashboard while nothing
   is being probed.

Both defects are invisible to any check that reads `Health.Status`, because the
failure mode *is* that `Health.Status` stops being written.

## What is installed

**`podman-healthcheck@.timer` / `.service`** — a fallback scheduler keyed on the
container **name** rather than its ID, so it survives recreation. Enabled for
every container on this host that declares a healthcheck:

```
systemctl --user enable --now podman-healthcheck@az-tei-embed.timer
systemctl --user enable --now podman-healthcheck@az-tei-reranker.timer
systemctl --user enable --now podman-healthcheck@az-rerank-onnx.timer
systemctl --user enable --now podman-healthcheck@cadvisor-host.timer
systemctl --user enable --now podman-healthcheck@calibre-web-automated.timer
```

`podman healthcheck run` writes `Health.Log`/`Health.Status` exactly as podman's
own timer would, so `podman ps`, `podman_container_health` and everything
downstream see no difference.

**`container-health-audit.timer`** — every 15 min, reports and posts to Discord
(via the agent-bus notifier, on *change* only) when it finds:

| finding | meaning |
|---|---|
| `NO_TIMER` | healthcheck declared, nothing scheduling it — status is frozen |
| `ORPHANED_TIMER` | timer for a container that no longer exists |
| `STUCK_STARTING` | still `starting` well past `start_period` |
| `UNHEALTHY` | the ordinary case |
| `STALE` | running, but the last probe is older than it should be |

Run it by hand any time: `python3 container_health_audit.py`.

## Adding a container

1. Declare the healthcheck **explicitly** — in `compose.yml` as
   `test: ["CMD-SHELL", "<one string>"]`, or as `--health-cmd` for a
   `podman run` unit. Never rely on the image's `HEALTHCHECK`.
   Use `CMD-SHELL`, not exec-form `CMD`: podman-compose 1.0.6 renders exec-form
   argv by joining it with a literal quote-space-quote, so
   `["CMD","curl","-sf",URL]` is stored as `/bin/sh -c curl' '-sf' 'URL`. That
   happens to survive (the quoted spaces re-concatenate) but breaks outright the
   moment any argument contains a real space.
2. `systemctl --user enable --now podman-healthcheck@<container-name>.timer`
3. Confirm with `python3 container_health_audit.py`.

Step 2 is not optional-but-nice: without it the container is only scheduled for
as long as podman's transient timer happens to survive, and the audit will flag
it as `NO_TIMER` the first time a recreate drops it.
