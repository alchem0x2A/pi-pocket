# Extras

Optional drop-in extensions for Pi Pocket. Pi Pocket does not load anything from this folder. To use one, copy its
files into the drop-in folder (`~/.pi-pocket/extensions/`), then turn it on in Menu → Extensions. A new drop-in always
starts off, and only the owner turns it on. Read a file before you turn it on: a drop-in runs with the owner's rights.

> **Works for me, not for you.** These are one person's own setup, shared as they are. They are not tested on other
> machines, they need that person's logins and folders, and they can break when a provider changes something. Paths,
> account names, and model names are examples to change. Nobody maintains them for you. Read the code, then change it
> to fit your machine, or leave it.

## `tt-providers/`

`tt-providers.ts` registers two Claude Code subscriptions as providers: `claude-code` (the `~/.claude` login) and
`claude-code-personal` (the `~/.claude-personal` login). It uses the checked-in `pi-claude-code/` source copy and the
Claude CLI at `~/.local/bin/claude`. The copy is based on upstream commit `0065a1f` and includes the cache breakpoint fix.
Each account runs with its own `CLAUDE_CONFIG_DIR`, so the two never mix. Pi Pocket never stores their tokens: the Claude
CLI owns the login.

Pi Pocket does not need the npm package. Copy both `tt-providers.ts` and the `pi-claude-code/` directory into
`~/.pi-pocket/extensions/`, then turn on the drop-in. This does not change the npm package used by standalone `pi`.
For an upstream update, review the new source, keep the local cache fix and regression test, and run `npm test` in
`pi-claude-code/`.

## `tt-usage/`

Shows how much of each provider account is left: OpenAI, Codex, and the two Claude accounts.

Files:

- `tt-usage.ts`: the module. It adds a tool `provider_usage`, a tool `provider_usage_probe`, two owner-only routes, and settings.
- `tt-usage.js`: the browser module. It adds a status-line item `usage` that opens a sheet with one line for each account and a Refresh button.
- `tt-usage-codex.py`: a helper that reads Codex usage. Copy it to `~/.pi-pocket/tt-usage-codex.py`.

How it works:

- **Claude** (both accounts): reads `https://api.anthropic.com/api/oauth/usage` with the token in the account's
  `.credentials.json`. It shows percent left in the 5-hour and weekly windows, and the reset time.
- **OpenAI and Codex**: no usage endpoint works for them, so Refresh sends one tiny request, through Pi's own model
  runtime, and tells whether the provider answered. Codex also tries the helper for percent numbers once. That endpoint
  is not published and may answer 403 (a Cloudflare check): then the sheet shows a yes or no only.
- **Never automatic**: the OpenAI and Codex probes run only when a person presses Refresh. A page load and the timer
  never send them. Numbers are cached for 300 seconds.
- **After a restart**: the model runtime is not there until any session sends a request. Until then Refresh says
  "Press Refresh to check." Press it again after one message in any session.
- **Private**: the routes, the tools, and the browser module are for the owner only. The module reads tokens from the
  credential files at run time, and never prints, stores, or returns one. Pi renews its own sign-ins and writes
  `~/.pi/agent/auth.json`; this module never writes it.
- **Settings**: Menu → Extensions → tt-usage has one JSON box for each account (URL, method, headers, field paths,
  cache seconds, shell command, probe model). Clear a box to get the default.

Times show in `America/Edmonton`. Change the `ZONE` constant in `tt-usage.ts` for another zone.
