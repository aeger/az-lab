# Gmail OAuth Setup for AZ-Lab

## TL;DR — What's Broken and Why

Refresh tokens expire every **7 days** because the GCP project is in **Testing mode**. The fix is to move it to **Published** (no Google verification required for personal single-user use).

The secondary problem: the current GCP project (`cook-family-lab`) is under a **Google Workspace org**. Your personal Gmail account (`almty1@gmail.com`) is not a Workspace member, so Internal-only mode doesn't work, and managing test users is locked behind org admin controls.

**Solution:** New GCP project under your personal Google account. Published, External. Tokens never expire.

---

## What Gets Fixed

| Issue | Fix |
|-------|-----|
| Refresh token expires every 7 days | Publish the app (Testing → Production) |
| Can't add test users (Workspace org restriction) | New project under personal Gmail |
| Gmail MCP token dead (`invalid_grant`) | Re-auth after new project setup |
| Dashboard Gmail widget needs fresh auth | Re-auth after new project setup |

---

## Do I Need Google Verification?

**No.** Verification is only required if your app will be used by **external users who are not you**. For a personal homelab:

- You are the only user
- No public listing on Google's app directory
- You just click through a one-time "This app isn't verified" warning

Google's verification process is for apps deployed to the public (e.g., a SaaS product accessing Gmail for thousands of customers). It is **not** required for personal/internal tools.

---

## Part 1 — GCP Project Setup

### Step 1: Create a New Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Sign in as **almty1@gmail.com** (personal account, NOT a Workspace account)
3. Click the project selector → **New Project**
4. Name: `az-lab-services`
5. Organization: **No organization** (important — must be personal account)
6. Click **Create**

### Step 2: Enable Gmail API

1. In the new project, go to **APIs & Services → Library**
2. Search `Gmail API`
3. Click **Enable**

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. User Type: **External** → **Create**
3. Fill in:
   - **App name:** `AZ-Lab Services`
   - **User support email:** `almty1@gmail.com`
   - **Developer contact:** `almty1@gmail.com`
   - Logo: optional, skip it
4. Click **Save and Continue**

**Scopes page:**
5. Click **Add or Remove Scopes**
6. Add these scopes:

   For Gmail MCP (full triage access):
   ```
   https://mail.google.com/
   ```

   For Dashboard inbox widget (read-only):
   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

   > Note: `https://mail.google.com/` is a "restricted" scope. Google will show a warning about it, but for personal use this is fine — just acknowledge and continue.

7. Click **Update** → **Save and Continue**

**Test users page:**
8. Skip this — you're going to **Publish** the app so test user limits don't apply.
9. Click **Save and Continue** → **Back to Dashboard**

### Step 4: Publish the App

This is the critical step that stops tokens from expiring.

1. On the OAuth consent screen page, you'll see **Publishing status: Testing**
2. Click **Publish App**
3. Confirm the dialog

> Google may say "Your app will be available to any Google user" — that's fine. It's still private; no one else has your client credentials, so no one else can use it.

**After publishing:** Refresh tokens issued to your account **never expire**.

---

## Part 2 — Create OAuth Credentials

You need **two separate OAuth clients** (or one if you want to simplify):

### Option A: Two Clients (Recommended — keeps things clean)

**Client 1: Gmail MCP Server** (Desktop app type)
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Desktop app**
3. Name: `az-lab-gmail-mcp`
4. Click **Create**
5. Download the JSON or copy the Client ID and Secret

**Client 2: Dashboard Gmail Widget** (Web application type)
1. **Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: `az-lab-dashboard`
4. Authorized redirect URIs:
   ```
   https://home.az-lab.dev/api/gmail/auth/callback
   ```
5. Click **Create**
6. Copy the Client ID and Secret

### Option B: One Client (Simpler)

Use a single **Web application** client for both, with redirect URIs:
```
https://home.az-lab.dev/api/gmail/auth/callback
http://localhost:3000/callback
```

---

## Part 3 — Re-Auth the Gmail MCP Server

### Update credentials in .env

```bash
# Edit /home/almty1/azlab/services/gmail-mcp-server/.env
GMAIL_CLIENT_ID=<new-client-id>
GMAIL_CLIENT_SECRET=<new-client-secret>
GMAIL_REFRESH_TOKEN=   # clear this — will be filled by auth-server.py
```

### Run the auth flow

1. **On your Windows machine**, open a terminal and run:
   ```
   ssh -L 3000:localhost:3000 almty1@192.168.1.181
   ```
   Leave this tunnel open.

2. **In a second terminal (SSH to svc-podman-01)**:
   ```bash
   python3 /home/almty1/azlab/services/gmail-mcp-server/auth-server.py
   ```

3. The script prints an auth URL. **Copy it and open in your browser.**

4. Google shows "This app isn't verified" → click **Advanced** → **Go to AZ-Lab Services (unsafe)**
   > This warning only appears once per account/app combination.

5. Grant the requested scopes.

6. Browser shows "Authorization successful!" — close the tab.

7. The script automatically:
   - Exchanges the auth code for tokens
   - Writes `GMAIL_REFRESH_TOKEN=...` to the `.env` file
   - Restarts the gmail-mcp-server container

---

## Part 4 — Re-Auth the Dashboard Gmail Widget

1. Update `/home/almty1/dashboard/.env` with the new dashboard OAuth credentials:
   ```
   GMAIL_CLIENT_ID=<dashboard-client-id>
   GMAIL_CLIENT_SECRET=<dashboard-client-secret>
   GMAIL_REFRESH_TOKEN=   # clear this
   ```

2. Rebuild and restart the dashboard container:
   ```bash
   cd ~/dashboard && ./build.sh && systemctl --user restart compose-stack@dashboard
   ```
   (or however you normally rebuild)

3. Visit **https://home.az-lab.dev** → look for the Gmail auth button or navigate to `/api/gmail/auth` directly.

4. Complete the Google OAuth flow in your browser.

5. Refresh token is stored automatically in the container volume.

---

## Part 5 — Verify Everything Works

```bash
# Gmail MCP health check
curl https://gmail-mcp.az-lab.dev/health

# Dashboard Gmail API check
curl -s https://home.az-lab.dev/api/gmail -H "Cookie: authelia_session=..." | jq .

# Check MCP token validity
podman exec az-gmail-mcp cat .env | grep REFRESH_TOKEN
```

---

## Ongoing Maintenance

With the app **Published**, refresh tokens do not expire. You only need to re-auth if:
- You revoke access manually at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
- The client secret is rotated (you change it in GCP console)
- You delete and recreate the OAuth client

**To check token health:**
```bash
curl -s "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=CLIENT_ID&client_secret=CLIENT_SECRET&refresh_token=REFRESH_TOKEN&grant_type=refresh_token" \
  | jq -r .access_token)"
```

---

## If You Ever Want Google Verification (Optional)

Verification is only needed if you want to remove the "unverified app" warning for other users. For a personal homelab you don't need this. If you ever do:

1. The app must have a **Privacy Policy** URL (can be a simple hosted HTML page)
2. The app must have a **Homepage URL**
3. You submit for review at the OAuth consent screen page
4. Google reviews within 3-7 business days for sensitive scopes, longer for restricted
5. You pass a security assessment for `mail.google.com` scope (Google may require a video demo or written explanation of use case)

**For the submission form you would fill:**
- App name: `AZ-Lab Services`
- App homepage: `https://home.az-lab.dev`
- Privacy policy: `https://home.az-lab.dev/privacy` (you'd need to create this)
- Justification for `mail.google.com` scope: "Personal homelab tool. Single user (developer only). Used for automated email triage and inbox management. No user data is stored or shared with third parties."
- Justification for `gmail.readonly`: "Personal inbox widget on homelab dashboard. Single user only."

Again — **you do not need this for personal use.**

---

## Summary Checklist

- [ ] Create new GCP project under `almty1@gmail.com` with **No organization**
- [ ] Enable Gmail API
- [ ] Configure OAuth consent screen (External, add scopes)
- [ ] **Publish the app** (Testing → Production) ← this is the critical step
- [ ] Create OAuth credentials (Desktop app for MCP, Web app for Dashboard)
- [ ] Update `.env` files with new credentials
- [ ] Run `auth-server.py` via SSH tunnel for MCP re-auth
- [ ] Re-auth Dashboard via browser flow
- [ ] Verify both integrations work
