#!/usr/bin/env python3
"""
register-hang-hooks.py — Register the two watchdog hang-detection signal hooks in
~/.claude/settings.json. Run by Jeff because Wren is permission-blocked from
writing under ~/.claude in this mode.

Adds (idempotently):
  • Stop        → ~/.wren-watchdog/signal-last-response.sh, PREPENDED so it runs
                  before heartbeat-on-stop.sh (which deletes pending_reaction.json).
  • PostToolUse → ~/.wren-watchdog/signal-last-tool.sh, matcher ".*" (all tools).

Both target scripts already exist in ~/.wren-watchdog (created by Wren) and only
write local timestamp files — no network, no secrets. A timestamped backup of
settings.json is written before any change. Safe to run more than once.
"""
import json, os, shutil, sys, time

SETTINGS = os.path.expanduser("~/.claude/settings.json")
RESP_HOOK = "bash /home/almty1/.wren-watchdog/signal-last-response.sh"
TOOL_HOOK = "bash /home/almty1/.wren-watchdog/signal-last-tool.sh"

def cmds(entries):
    out = []
    for group in entries:
        for h in group.get("hooks", []):
            out.append(h.get("command", ""))
    return out

with open(SETTINGS) as f:
    data = json.load(f)

backup = f"{SETTINGS}.bak-{int(time.time())}"
shutil.copy2(SETTINGS, backup)

hooks = data.setdefault("hooks", {})
changed = []

# Stop — prepend signal-last-response.sh (must run before heartbeat-on-stop.sh)
stop = hooks.setdefault("Stop", [])
if RESP_HOOK not in cmds(stop):
    stop.insert(0, {"hooks": [{"type": "command", "command": RESP_HOOK,
                               "timeout": 3, "statusMessage": "Recording response signal..."}]})
    changed.append("Stop: signal-last-response.sh (prepended)")
else:
    print("• Stop hook already registered — skipping")

# PostToolUse — add signal-last-tool.sh for all tools
ptu = hooks.setdefault("PostToolUse", [])
if TOOL_HOOK not in cmds(ptu):
    ptu.append({"matcher": ".*", "hooks": [{"type": "command", "command": TOOL_HOOK,
                                            "timeout": 3, "statusMessage": "Recording tool signal..."}]})
    changed.append("PostToolUse: signal-last-tool.sh (matcher .*)")
else:
    print("• PostToolUse hook already registered — skipping")

if not changed:
    print("Nothing to do — both hooks already present.")
    os.remove(backup)
    sys.exit(0)

# Validate it still parses, then write atomically
tmp = SETTINGS + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
with open(tmp) as f:
    json.load(f)  # raises if malformed
os.replace(tmp, SETTINGS)

print(f"Backup: {backup}")
for c in changed:
    print(f"  + {c}")
print("Done. Stop hook order: signal-last-response.sh now runs before heartbeat-on-stop.sh.")
