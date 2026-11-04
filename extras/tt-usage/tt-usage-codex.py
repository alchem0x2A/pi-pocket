# Private helper for tt-usage.ts: prints the Codex usage JSON (no token). Python's HTTP stack passes Cloudflare where Node and curl do not.
import json, os, sys, time, urllib.request, urllib.error
a = json.load(open(os.path.expanduser("~/.pi/agent/auth.json")))["openai-codex"]
h = {"Authorization": "Bearer " + a["access"], "Chatgpt-Account-Id": a["accountId"], "originator": "codex_cli_rs",
     "User-Agent": "codex_cli_rs/0.50.0 (Linux 6.11.0 x86_64)", "Accept": "application/json"}
for i in range(1):
    try:
        req = urllib.request.Request("https://chatgpt.com/backend-api/codex/usage")
        for k, v in h.items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.load(r)
        for k in ("user_id", "account_id", "email"):
            d.pop(k, None)
        print(json.dumps(d)); sys.exit(0)
    except urllib.error.HTTPError as e:
        if e.code != 403: print("HTTP %d" % e.code, file=sys.stderr); sys.exit(1)
    time.sleep(4 * (i + 1))
print("HTTP 403 after retries", file=sys.stderr); sys.exit(1)
