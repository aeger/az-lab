# Backup & Restore Runbook

Owner: Wren · Updated: 2026-05-28 · Goal: `04f836a2 — Immutable backups + snapshots`

This runbook documents the three-layer backup posture and the periodic
restore tests that prove each layer actually works.

---

## Backup layers

### 1. VM-level backups (vzdump on Proxmox)

- Schedule: nightly at **21:00 az-lab local** (`/etc/pve/jobs.cfg`, job
  `backup-7657d841-0dcc`).
- Mode: `snapshot` (live, no downtime).
- Compression: `zstd`.
- Retention: **keep-daily=14, keep-weekly=4, keep-monthly=6** (GFS).
- Target: storage `local-datastore` → `/nvme-fast/datastore/dump/`.
- Covered guests: **100, 101, 102, 103, 105, 106, 107, 108, 109**
  (every running and stopped VM/LXC on the node).

### 2. ZFS snapshots (sanoid)

- Service: `sanoid.timer` runs every 15 minutes (`/etc/sanoid/sanoid.conf`).
- Policy template `production`: hourly=24, daily=14, weekly=4, monthly=6.
- Datasets: recursive on `nvme-fast` and `nvme-fast-02`.
- Why this matters: every vzdump file, every VM disk, and the Supabase
  export tree live on `nvme-fast`. Each is therefore pinned by ZFS
  snapshots that only root on the Proxmox host can prune — a
  ransomware/agent-error layer of protection over the userland files.

### 3. Supabase daily export (svc-podman-01)

- Service: `supabase-export.timer` (user unit) fires at **03:15 UTC daily**.
- Script: `/home/almty1/azlab/services/backups/bin/supabase-export.py`.
- Output: `/home/almty1/backups/supabase/YYYY-MM-DD/{table}.json.gz` + `manifest.json`.
- Source: PostgREST on `ogqjjlbupqnvlcyrfnxi.supabase.co`, paginated via
  Range headers so all rows are captured (no silent 1000-row truncation).
- Retention: 60 days local; further immutability provided by the ZFS
  snapshots layer above.

### Offsite / immutable target (deferred)

R2 push is not yet wired — the Cloudflare token currently on this host
is scoped to DNS/`az-lab-cdn` read. To finish this layer:

1. Provision a new R2 API token with read/write on a new bucket
   `az-lab-backups`.
2. Enable bucket versioning + a 90-day lifecycle on noncurrent versions.
3. Drop credentials into `/home/almty1/.config/rclone/rclone.conf` under
   a new `[r2-backups]` remote.
4. Add an `ExecStartPost=` to `supabase-export.service` that runs
   `rclone copy /home/almty1/backups/supabase/$(date -u +%F) r2-backups:az-lab-backups/supabase/$(date -u +%F)`.

Until then, backups are local-only with ZFS-snapshot immutability.

---

## Monthly restore test (first Sunday)

Pick one item from each layer, restore to a scratch location, prove it
loads. Log the outcome below.

### Test 1 — VM restore

```bash
ssh proxmox 'ls /nvme-fast/datastore/dump/*.vma.zst | tail -3'
# Pick the most recent dump for VM 109 (grocy, smallest LXC). Restore to
# a throwaway VMID:
ssh proxmox 'pct restore 199 /nvme-fast/datastore/dump/vzdump-lxc-109-<stamp>.tar.zst -storage nvme-fast -unprivileged 1'
ssh proxmox 'pct start 199 && pct status 199'
ssh proxmox 'pct destroy 199 --purge'
```

Pass criteria: container starts, then cleans up without complaint.

### Test 2 — ZFS rollback (read-only)

```bash
ssh proxmox 'zfs list -t snapshot nvme-fast/subvol-109-disk-0 | head -5'
# Clone (not rollback) the latest hourly so we don't touch live data.
ssh proxmox 'zfs clone nvme-fast/subvol-109-disk-0@autosnap_$(date -u +%Y-%m-%d)_03:00:00_hourly nvme-fast/restore-test'
ssh proxmox 'ls /nvme-fast/restore-test/ | head'
ssh proxmox 'zfs destroy nvme-fast/restore-test'
```

Pass criteria: clone mounts, contents visible, clone destroys cleanly.

### Test 3 — Supabase row recovery

```bash
ls ~/backups/supabase/$(date -u +%F)/
zcat ~/backups/supabase/$(date -u +%F)/system_rules.json.gz | jq '.[0:2]'
zcat ~/backups/supabase/$(date -u +%F)/manifest.json | jq '.failures, .tables.system_rules'
```

Pass criteria: manifest reports `failures: 0`, a sample table has rows,
JSON parses cleanly.

### Logging the test

Append to `backups/restore-tests.md` in this directory:

```
## YYYY-MM-DD restore test
- VM:      pass/fail — <notes>
- ZFS:     pass/fail — <notes>
- Supabase: pass/fail — <notes>
- Runtime: <minutes>
```

---

## Files & units (where to look when something breaks)

| Layer | File / unit | Host |
|-------|-------------|------|
| vzdump job | `/etc/pve/jobs.cfg` (backup `pvebackup@.timer`) | proxmox |
| sanoid | `/etc/sanoid/sanoid.conf`, `sanoid.timer` | proxmox |
| Supabase export | `~/azlab/services/backups/bin/supabase-export.py` | svc-podman-01 |
| Supabase timer | `~/.config/systemd/user/supabase-export.timer` | svc-podman-01 |
| Export env | `~/azlab/services/backups/supabase-export.env` (chmod 600) | svc-podman-01 |
| Export logs | `~/backups/logs/supabase-export.log` | svc-podman-01 |
| Local dumps | `~/backups/supabase/YYYY-MM-DD/` | svc-podman-01 |
