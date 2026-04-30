#!/usr/bin/env python3
"""
Gmail OAuth2 Auth Server for svc-podman-01.

Run on svc-podman-01 while SSH tunneling port 3000:
  ssh -L 3000:localhost:3000 almty1@192.168.1.181

Then visit the auth URL shown below in your browser.
"""
import http.server
import urllib.parse
import urllib.request
import json
import os
import subprocess
import sys
import threading

CLIENT_ID = "552673314433-h7hfganol73q0s75tn73d80iaa7k4d31.apps.googleusercontent.com"
CLIENT_SECRET_FILE = "/home/almty1/azlab/services/gmail-mcp-server/.env"
REDIRECT_URI = "http://localhost:3000/callback"
SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.sharing"
ENV_FILE = "/home/almty1/azlab/services/gmail-mcp-server/.env"

def read_client_secret():
    with open(CLIENT_SECRET_FILE) as f:
        for line in f:
            if line.startswith("GMAIL_CLIENT_SECRET="):
                return line.strip().split("=", 1)[1]
    raise ValueError("GMAIL_CLIENT_SECRET not found in .env")

def build_auth_url():
    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

def exchange_code(code, client_secret):
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": CLIENT_ID,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def update_env(refresh_token):
    with open(ENV_FILE) as f:
        lines = f.readlines()
    with open(ENV_FILE, "w") as f:
        for line in lines:
            if line.startswith("GMAIL_REFRESH_TOKEN="):
                f.write(f"GMAIL_REFRESH_TOKEN={refresh_token}\n")
            else:
                f.write(line)
    print(f"Updated {ENV_FILE} with new refresh token.")

def restart_container():
    result = subprocess.run(
        ["systemctl", "--user", "restart", "compose-stack@gmail-mcp-server"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        # Try podman restart directly
        subprocess.run(["podman", "restart", "az-gmail-mcp"], capture_output=True)
    print("Container restarted.")

captured_code = [None]
server_done = threading.Event()

class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/callback":
            params = urllib.parse.parse_qs(parsed.query)
            code = params.get("code", [None])[0]
            error = params.get("error", [None])[0]

            if error:
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(f"<h2>Auth failed: {error}</h2>".encode())
                server_done.set()
                return

            if code:
                captured_code[0] = code
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h2>Authorization successful! Close this tab.</h2>")
                server_done.set()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress log output

def main():
    client_secret = read_client_secret()
    auth_url = build_auth_url()

    print("\n=== Gmail MCP Auth Server ===\n")
    print("Step 1: On your Windows machine, run:")
    print("  ssh -L 3000:localhost:3000 almty1@192.168.1.181")
    print("\nStep 2: Visit this URL in your browser:")
    print(f"\n  {auth_url}\n")
    print("Waiting for OAuth callback on port 3000...")

    httpd = http.server.HTTPServer(("localhost", 3000), CallbackHandler)
    thread = threading.Thread(target=httpd.serve_forever)
    thread.daemon = True
    thread.start()

    server_done.wait(timeout=600)  # 10 minute timeout
    httpd.shutdown()

    code = captured_code[0]
    if not code:
        print("ERROR: Timed out waiting for auth callback.")
        sys.exit(1)

    print("Code received, exchanging for tokens...")
    tokens = exchange_code(code, client_secret)
    refresh_token = tokens.get("refresh_token")

    if not refresh_token:
        print("ERROR: No refresh_token in response. Revoke app access at https://myaccount.google.com/permissions and retry.")
        sys.exit(1)

    print(f"Got refresh token: {refresh_token[:20]}...")
    update_env(refresh_token)
    restart_container()
    print("\nDone! Gmail MCP is re-authed and running.")

if __name__ == "__main__":
    main()
