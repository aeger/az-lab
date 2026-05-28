# Gmail OAuth — Verification & Decision Plan

**Status:** Decision doc — Option D selected. Implementation lives in [gmail-oauth-setup.md](./gmail-oauth-setup.md).
**Date:** 2026-05-26 (regenerated 2026-05-28)
**Owner:** Jeff

---

## Problem Statement

Gmail refresh tokens for the az-lab integrations (`gmail-mcp-server`, `dashboard` Gmail widget, `ms-smtp-relay`) expire every **7 days**.

**Root cause:** The active GCP project (`cook-family-lab`) is in **Testing** publishing status with **External** user type. Google issues 7-day refresh tokens to Testing+External apps by policy, regardless of scope sensitivity.

**Compounding factor:** `cook-family-lab` lives under a Google Workspace organization, but the authenticating user (`almty1@gmail.com`) is a personal Gmail account, not a Workspace member. This blocks the simplest fix (User Type = Internal).

---

## Option Comparison

| Option | One-time Cost | Recurring Cost | Timeline | Verification Required | Token Lifetime | Scope Loss |
|--------|---------------|----------------|----------|-----------------------|----------------|------------|
| **A — Reduce scopes + verify** | ~20–40 hr | $0 | 2–6 weeks | Yes (Sensitive) | Permanent | Drop `mail.google.com`, lose permanent-delete + send-as |
| **B — Google Workspace on az-lab.dev** | ~2 hr | $6/mo (~$72/yr) | 1 day | No (Internal) | Permanent | None |
| **C — Automate 7-day reauth** | ~4–8 hr | $0 (toil) | 1–2 days | No | 7 days (rotating) | None |
| **D — New personal GCP project, Publish External** ✅ | ~2 hr | $0 | 1–2 hours | No (single-user exemption) | Permanent | None |

### Why each option works (or doesn't)

**Option A — Reduce to Sensitive + verify**
- Drop `https://mail.google.com/` (restricted) → use `gmail.modify` + `gmail.send` (sensitive)
- Requires: privacy policy URL, public homepage, app logo, video demo for Google reviewer
- Verification queue: 2–6 weeks at Google's pace, can bounce back for revisions
- Loses: permanent delete (only trash), send-as alias management
- **Verdict:** High cost, slow, feature-incomplete. Pass.

**Option B — Workspace on az-lab.dev**
- $6/mo Business Starter, makes `jeff@az-lab.dev` a Workspace identity
- Set OAuth consent screen User Type = **Internal** → tokens never expire, no verification ever
- Adds: dedicated workspace mailbox (could replace Gmail) but Jeff prefers existing `jeff@az-lab.dev` setup
- **Verdict:** Works perfectly but costs $72/yr forever for a problem Option D solves for free.

**Option C — Automate 7-day reauth**
- Cron job + headless browser (Playwright) to refresh token before expiry
- Fragile: Google can break automation, captcha challenges, account flags
- Doesn't solve root cause, just papers over it
- **Verdict:** Last-resort workaround. Pass.

**Option D — New GCP project under personal account, Publish External** ✅ SELECTED
- New project owned by `almty1@gmail.com` directly (no Workspace org)
- Publishing status: **In production** → no test user limit, no 7-day expiry
- User Type: **External** — but app is unlisted; only Jeff has the client credentials
- **Restricted scope (`mail.google.com`) does NOT require verification for personal/single-user use.** Google's verification gate triggers when an app exceeds 100 users or is publicly discoverable, not on scope alone. One-time "unverified app" warning, then permanent access.
- **Verdict:** Free, fast, full-feature, permanent. Selected.

---

## Verification Threshold — Clarification

The original plan over-estimated when Google requires verification. The actual rules:

| Trigger | Verification Required? |
|---------|------------------------|
| App in Testing mode | No (but tokens expire 7d) |
| App Published, External, < 100 users, no public listing | **No** — single-user/personal exemption |
| App Published, External, ≥ 100 users OR public listing | Yes |
| Restricted scope (`mail.google.com`) with public distribution | Yes + CASA security assessment |
| Restricted scope, single-user, unlisted | **No** — show "unverified app" warning once |

Source: Google OAuth API verification FAQ (2024 revision). The single-user exemption is what makes Option D viable without dropping `mail.google.com`.

---

## Orphaned GCP Project Investigation

Two distinct OAuth client ID prefixes appear in the repo:

| Client ID Prefix | Status | Found In |
|------------------|--------|----------|
| `520865675374-...` | **Active** | `services/gmail-mcp-server/.env`, `services/dashboard/.env`, `services/ms-smtp-relay/.env`, `~/dashboard/.env` |
| `552673314433-...` | **Stale** | `services/gmail-mcp-server/auth-server.py` (hardcoded constant) |

**Conclusion:** Only `520865675374-...` is live. The `552673314433-...` reference is a stale constant in `auth-server.py` left over from an earlier GCP project (or earlier client within the same project — unconfirmed without GCP console access).

**Action item for Option D rollout:** Both client IDs become defunct once the new `az-lab-services` project is stood up. Replace `auth-server.py`'s hardcoded `CLIENT_ID` with a `.env`-sourced value during the migration so this drift can't happen again.

---

## Recommendation

**Proceed with Option D.** Follow [gmail-oauth-setup.md](./gmail-oauth-setup.md) for step-by-step implementation.

**Sequencing:**
1. Stand up new GCP project + OAuth clients (~30 min)
2. Re-auth `gmail-mcp-server` via `auth-server.py` (fix hardcoded CLIENT_ID first)
3. Re-auth dashboard Gmail widget via browser flow
4. Re-auth `ms-smtp-relay` (uses same flow as gmail-mcp-server)
5. Delete old `cook-family-lab` OAuth clients to avoid drift
6. Verify all 3 integrations remain authenticated past 7 days

**Fallback:** If single-user exemption ever stops working (Google policy change), fall back to Option B (Workspace, $6/mo). Option A and C remain off the table.

---

## Related Documents

- [gmail-oauth-setup.md](./gmail-oauth-setup.md) — How-to guide for Option D implementation
- Supabase memory `eb1bf025-a844-46d7-9259-789a977d83bf` — summary memory pointing here
- Task `35ce63c3-0ca5-4cf8-97d0-de8b0aa03b3a` — original verification-plan task
- Task `5dcffcbf-3571-4421-a0e4-2ae5e3ff2f18` — Obsidian mirror (Atlas)
