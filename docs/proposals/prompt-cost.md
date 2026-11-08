# Proposal: the cost of the system prompt and the tool schemas

Status: research only. No code changed. Measured on 2026-11-07, at commit `d6c573b4`.

## Summary

| Case                                     | Prompt chars | Prompt tokens (Qwen / o200k) | Tools | Tool chars | Tool tokens (Qwen / o200k) | Total tokens (Qwen / o200k) |
| ---------------------------------------- | -----------: | ---------------------------: | ----: | ---------: | -------------------------: | --------------------------: |
| 1. Normal coding session                 |       16 279 |                  4054 / 3957 |     8 |       3631 |                  807 / 807 |             **4861 / 4764** |
| 2. Pia conversation                      |       23 837 |                  5833 / 5680 |    28 |     23 422 |                5354 / 5375 |         **11 187 / 11 055** |
| 3. Most tools (every module, all loaded) |       29 979 |                  7360 / 7164 |    32 |     29 410 |                6869 / 6893 |         **14 229 / 14 057** |

- The tool tokens are for compact JSON (`name`, `description`, `parameters`). The wire form of `openai-completions` (`{"type":"function","function":…}`, with spaces) costs more: 1050, 6680, and 8690 Qwen tokens.
- Check against a real request: conversation `163694` (local Qwen, 8 tools, before memory) reported 5240 input tokens on its first request. The same prompt, tools, and user message measure 4991 Qwen tokens here. The rest (about 250) is the chat template.
- The 5 largest parts of a normal session: `skills` 1336, `project_context` 727, `ink_board` 506, `guidelines` 389, `pocket_docs` 371 (Qwen tokens).
- The 5 largest parts of a Pia conversation: `skills` 1336, `pia_rules` 1009, the `browser` schema 948, `pia` (preamble) 648, the `repo_watch` schema 507.
- The 5 best cuts (tokens saved per request): drop once-loaded tools in Pia at compaction or Start fresh (Pia about 2900), defer Pia's GitHub and rare session tools (Pia about 1260), lazy `ink_board` (about 480), compact `skills` (about 450), and Pia-only trims of `pia_rules` and duplicate sections (Pia about 740). Cut 3 (lazy guides last) saves no tokens per request, but it stops a 5600-token re-send each time a tool with a guide loads.

## Method

- **Real text.** Pia stores each rendered section and each tool declaration in `pi.system` entries (`sections`, `toolsAdded`, `toolsRemoved`). Folding them in order (and starting again at `pi.compaction` and `pi.reset`) gives exactly what the model gets. Case 1 is this session (conversation `164404`, folder `/home/ttian7/Dev/pi-pocket`). Case 2 is Pia's conversation `3` after its last compaction (entry `163638`, then `164388`).
- **Memory.** The running server started before the memory host existed, so case 1 has no `memory` section and no note tools. The case adds them as the code at `d6c573b4` renders them (`memory` 501 chars, `note_search`, `note_load`).
- **Case 3.** A throwaway app (`test/helpers.ts` with a temporary data folder and the scripted model) with every built-in module on, and with `PI_POCKET_TOOL_DISCOVERY=on`. It rendered every section with every deferred tool loaded. The case uses the same `skills` and `project_context` as case 1. It does not include Pia's own tools or the owner's `tt-*` modules.
- **Tokenizers.** Qwen3.6 (`Qwen/Qwen3.6-35B-A3B` `tokenizer.json`, the family of the local models) and `o200k_base` (GPT). No Claude tokenizer is available offline. Claude counts are often 10 to 20% higher than o200k for English and JSON. Characters divided by 4 is close: 4977, 11 814, and 14 847.
- **Scripts.** They are in `/tmp/pcost/scripts/` (temporary, not in the repository). They read `~/.pi-pocket/pocket.sqlite` read-only.

## Where each part comes from

How the parts reach the model: Pi Durable renders each selected extension's sections in order before each request (`planSystemEntries` in `pi-durable/dist/harness/prompt.js`). A section is wrapped as `<key>…</key>` unless it has `tag: false`. Only the changed sections go in a new `pi.system` entry. The provider then gets them in one of 2 ways (`resolveTranscript` in `pi-ai/dist/utils/transcript.js`):

- Models with `supportsMidConvoSystemMessages` (Claude 4.8 and later, GPT-5.4 and later): later changes go as small system updates in place.
- All other models, including every local `openai-completions` model: `collapseSystemMessages` folds every change into the first system message. Any change rewrites the prompt prefix from that section on.

### Sections

| Section             | File                                   | Function                                                                       | Rendered when                            |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `preamble`          | `src/server/extensions/prompt.ts`      | `createPrompt`, constant `PREAMBLE`                                            | Not a Pia chat                           |
| `guidelines`        | `src/server/extensions/prompt.ts`      | `createPrompt`, constant `GUIDELINES`                                          | Always                                   |
| `pocket_docs`       | `src/server/extensions/prompt.ts`      | `docs(dataDir)`                                                                | Always                                   |
| `project_context`   | `src/server/extensions/prompt.ts`      | `projectContext` (from `loadProjectContextFiles` of pi-coding-agent)           | AGENTS.md files found                    |
| `skills`            | `src/server/extensions/prompt.ts`      | `load` (from `formatSkillsForPrompt` in `pi-coding-agent/dist/core/skills.js`) | Skills found                             |
| `environment`       | `src/server/extensions/prompt.ts`      | `createPrompt`, inline                                                         | Always                                   |
| `artifacts`         | `src/server/extensions/artifacts.ts`   | `guide`                                                                        | Lazy: `artifact` loaded                  |
| `browser`           | `src/server/extensions/browser.ts`     | constant `GUIDE`                                                               | Lazy: `browser` loaded                   |
| `subagents`         | `src/server/extensions/subagents.ts`   | `guide(host, model)`                                                           | Lazy: `subagent` loaded                  |
| `agent-teams`       | `src/server/extensions/agent-teams.ts` | inline section                                                                 | Lazy: `team` loaded                      |
| `schedules`         | `src/server/extensions/schedules.ts`   | constant `GUIDE`                                                               | Lazy: `schedule` loaded                  |
| `background_tasks`  | `src/server/extensions/background.ts`  | constant `GUIDE`                                                               | Lazy: `background` loaded                |
| `goal`, `plan_mode` | `goals.ts`, `plan.ts`                  | inline sections                                                                | A goal or plan mode is set               |
| `codemode`          | `src/server/extensions/codemode.ts`    | inline section                                                                 | Lazy: `codemode` loaded                  |
| `memory`            | `src/server/extensions/memory.ts`      | `render(project, count)`, constant `RULES`                                     | Always                                   |
| `inbox-notes`       | `src/server/extensions/inbox-notes.ts` | constant `GUIDE`                                                               | Always (not lazy)                        |
| `design_mode`       | `src/server/design/guide.ts`           | `designGuide`                                                                  | Lazy: a design tool loaded               |
| `ink_board`         | `src/server/extensions/ink-board.ts`   | `const prompt = section(…)`                                                    | Always (not lazy), when the module is on |
| `available_tools`   | `src/server/local-tools.ts`            | `availableTools`, `shortDescription`, `SHORT_DESCRIPTIONS`                     | Always                                   |
| `tool_discovery`    | `src/server/local-tools.ts`            | `policy`, inline text                                                          | Always                                   |
| `task_focus`        | `src/server/local-tools.ts`            | `policy`, constant `TASK_FOCUS`                                                | Not a Pia chat                           |
| `pia`               | `src/server/extensions/pip.ts`         | `piaPreamble`                                                                  | Pia chat                                 |
| `pia_inbox`         | `src/server/extensions/pip.ts`         | inline section                                                                 | Pia chat with pending or tagged notes    |
| `pia_rules`         | `src/server/extensions/pip.ts`         | constant `RULES`                                                               | Pia chat                                 |
| `pia_github`        | `src/server/extensions/pip.ts`         | constant `GITHUB`                                                              | Pia chat, `gh` signed in                 |
| `pia_shared`        | `src/server/extensions/pip.ts`         | `host.pia.sharedContext()` (`src/server/pia.ts`)                               | Pia chat                                 |
| `pia_environment`   | `src/server/extensions/pip.ts`         | inline section                                                                 | Pia chat                                 |
| `instructions`      | Pi Durable                             | the conversation's `instructions`                                              | Set by a person                          |

The "lazy" rule is `LAZY_GUIDES` in `src/server/local-tools.ts` (`policy`): a known extension's sections render only when one of its tools is loaded. `ink-board` and `inbox-notes` are not in that set.

### Tool schemas

- Which tools go from the start: `BASE` in `src/server/local-tools.ts` (`read`, `write`, `bash`, `ls`, `rg`, `tool_search`, `tool_load`, `note_search`, `note_load`). `rg` is in only when `hasRipgrep()` finds it; this machine has none. Every other tool is wrapped `deferred: true` in `policy`, except the tools of `NEVER_DEFERRED` (`pocket-pip`): all Pia session tools go from the start in Pia.
- `read`, `write`, `edit`, `bash`: pi-coding-agent's built-in tools.
- `ls`, `tool_search`, `tool_load`, `rg`: `directoryTool`, `discoveryTool`, `loadTool`, `ripgrepTool` in `src/server/local-tools.ts`.
- `note_search`, `note_load`, `memory`: `createMemory` in `src/server/extensions/memory.ts`.
- `sessions`, `session_*`, `approvals`, `inbox`, `repo_watch`: `createPip` in `src/server/extensions/pip.ts`.
- Others: `artifact` and `artifact_inline` (`artifacts.ts`), `browser` (`browser.ts`), `subagent` (`subagents.ts`), `team` (`agent-teams.ts`), `schedule` (`schedules.ts`), `background` (`background.ts`), `codemode` (`codemode.ts`), `inbox_note` (`inbox-notes.ts`), `watch_pr` (`updates.ts`), `ask_someone` (`ask-someone.ts`), `request_restart` (`restart.ts`), `design_*` (`design.ts`), `ink_*` (`ink-board.ts`), `provider_usage` (`tt-usage.ts`, a drop-in of the owner).
- A loaded tool stays in `modelTools` on the branch, also after a compaction and after Start fresh (see entry `159949` after reset `159944`).

## Measurements

Tokens are Qwen3.6 / o200k. Section sizes include their `<key>` tags.

### Case 1: normal coding session

| Section           |      Chars |     Qwen |    o200k |
| ----------------- | ---------: | -------: | -------: |
| `preamble`        |        587 |      127 |      125 |
| `guidelines`      |       1650 |      389 |      378 |
| `pocket_docs`     |       1539 |      371 |      369 |
| `project_context` |       2965 |      727 |      709 |
| `skills`          |       4827 |     1336 |     1282 |
| `environment`     |         90 |       24 |       24 |
| `memory`          |        501 |      122 |      115 |
| `inbox-notes`     |        411 |      101 |      102 |
| `ink_board`       |       2193 |      506 |      505 |
| `available_tools` |        905 |      221 |      222 |
| `tool_discovery`  |        496 |      101 |       99 |
| `task_focus`      |        115 |       29 |       27 |
| **Prompt**        | **16 279** | **4054** | **3957** |

| Tool          |    Chars |    Qwen |   o200k |
| ------------- | -------: | ------: | ------: |
| `read`        |      648 |     150 |     150 |
| `note_search` |      599 |     133 |     133 |
| `bash`        |      520 |     111 |     111 |
| `tool_search` |      443 |      98 |      97 |
| `tool_load`   |      438 |      96 |      96 |
| `write`       |      399 |      83 |      84 |
| `note_load`   |      326 |      78 |      79 |
| `ls`          |      258 |      58 |      57 |
| **Tools (8)** | **3631** | **807** | **807** |

The `skills` section: 14 skills. 12 are marimo skills (1046 Qwen tokens); `ddgs` and `find-skills` cost 215. The 14 absolute `<location>` lines cost 403 tokens. The header costs 66.

The `guidelines` section: the ASD-STE100 bullet for `[via Pia]` messages costs 201 of its 389 tokens. The image bullet costs 65.

### Case 2: Pia conversation

| Section           |      Chars |     Qwen |    o200k |
| ----------------- | ---------: | -------: | -------: |
| `guidelines`      |       1650 |      389 |      378 |
| `pocket_docs`     |       1539 |      371 |      369 |
| `skills`          |       4827 |     1336 |     1282 |
| `environment`     |         91 |       25 |       25 |
| `browser`         |       1760 |      419 |      398 |
| `schedules`       |        264 |       62 |       60 |
| `inbox-notes`     |        411 |      101 |      102 |
| `ink_board`       |       2193 |      506 |      505 |
| `available_tools` |       1450 |      350 |      352 |
| `tool_discovery`  |        496 |      101 |       99 |
| `pia`             |       2807 |      648 |      637 |
| `pia_inbox`       |        195 |       59 |       56 |
| `pia_rules`       |       4338 |     1009 |      977 |
| `pia_github`      |       1310 |      307 |      300 |
| `pia_shared`      |        333 |       91 |       84 |
| `pia_environment` |        173 |       59 |       56 |
| **Prompt**        | **23 837** | **5833** | **5680** |

`memory` was absent in the last entry (`164388` removed it, an old server). With it, add about 122.

| Tool               |      Chars |     Qwen |    o200k |
| ------------------ | ---------: | -------: | -------: |
| `browser`          |       4063 |      948 |      927 |
| `repo_watch`       |       2215 |      507 |      517 |
| `session_start`    |       1605 |      351 |      357 |
| `ink_read`         |       1299 |      297 |      303 |
| `memory`           |       1120 |      262 |      263 |
| `session_schedule` |        939 |      254 |      249 |
| `schedule`         |        856 |      249 |      242 |
| `edit`             |       1148 |      235 |      238 |
| `inbox`            |        919 |      205 |      209 |
| `session_watch_pr` |        855 |      197 |      198 |
| `session_model`    |        702 |      156 |      158 |
| `read`             |        648 |      150 |      150 |
| `session_send`     |        685 |      143 |      147 |
| `request_restart`  |        617 |      133 |      135 |
| `sessions`         |        591 |      133 |      135 |
| `provider_usage`   |        563 |      131 |      131 |
| `bash`             |        520 |      111 |      111 |
| `tool_search`      |        443 |       98 |       97 |
| `tool_load`        |        438 |       96 |       96 |
| `session_read`     |        444 |       95 |       96 |
| `approvals`        |        383 |       91 |       93 |
| `ink_resolve`      |        396 |       87 |       91 |
| `ink_open`         |        368 |       85 |       88 |
| `write`            |        399 |       83 |       84 |
| `session_archive`  |        357 |       73 |       75 |
| `session_follow`   |        333 |       72 |       73 |
| `ls`               |        258 |       58 |       57 |
| `session_stop`     |        258 |       54 |       55 |
| **Tools (28)**     | **23 422** | **5354** | **5375** |

Of these 28 tools, 9 were loaded once with `tool_load` and stay: `browser`, `ink_read`, `ink_open`, `ink_resolve`, `edit`, `memory`, `schedule`, `request_restart`, `provider_usage` (2427 Qwen tokens). Two of them bring guides: `browser` (419) and `schedules` (62).

In Pia's `available_tools`, 24 of 35 lines say "Search for tool details" (239 tokens with no meaning). 13 lines name Pia tools that already go as full schemas (128 tokens).

### Case 3: most tools

Sections of case 1, plus every lazy guide:

| Extra section      | Chars | Qwen | o200k |
| ------------------ | ----: | ---: | ----: |
| `artifacts`        |  4984 | 1222 |  1188 |
| `design_mode`      |  2049 |  508 |   492 |
| `subagents`        |  1885 |  451 |   436 |
| `browser`          |  1760 |  419 |   398 |
| `agent-teams`      |  1111 |  260 |   252 |
| `background_tasks` |   627 |  146 |   144 |
| `codemode`         |   566 |  137 |   135 |
| `schedules`        |   264 |   62 |    60 |

`available_tools` grows to 1359 chars (322 Qwen). Prompt total: 29 979 chars, 7360 Qwen.

The 32 tools: the largest are `browser` 948, `artifact` 543, `artifact_inline` 426, `ink_edit` 331, `team` 331, `ink_read` 297, `subagent` 295, `codemode` 281, `memory` 262, `schedule` 249, `design_export` 240, `edit` 235, `background` 235. The 7 `ink_*` tools together cost 1058. Total: 29 410 chars, 6869 Qwen.

Pia with every module would be about case 2 plus `artifact`, `artifact_inline`, `subagent`, `team`, the other `ink_*` and `design_*` tools, and their guides: about 18 000 Qwen tokens.

## Who needs each part

| Part                                                                                                                               | Who needs it, how often                                                                         | Class                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `preamble`                                                                                                                         | Every session, every turn: durability, `interrupted` errors, `[from: Name]`.                    | Keep                                                                       |
| `guidelines`                                                                                                                       | Every session. The STE bullet only when a `[via Pia]` or linked message comes (a few sessions). | Shorten: move the STE bullet out                                           |
| `pocket_docs`                                                                                                                      | Only when someone asks about Pia itself (rare, except in this repository).                      | Shorten to about 100 tokens                                                |
| `project_context`                                                                                                                  | Every session in that project. The owner writes it.                                             | Keep (owner content)                                                       |
| `skills`                                                                                                                           | When a task matches a skill. The marimo skills matter only in marimo work.                      | Shorten the format; the owner can hide skills                              |
| `environment`                                                                                                                      | Every session.                                                                                  | Keep                                                                       |
| `memory`                                                                                                                           | Every session (note search rule).                                                               | Keep                                                                       |
| `inbox-notes`                                                                                                                      | Sessions that ask Pia for help: rare. Pia itself: never.                                        | Shorten; remove in Pia                                                     |
| `ink_board`                                                                                                                        | Only ink board work: rare.                                                                      | Load only when an `ink_*` tool is loaded                                   |
| `available_tools`                                                                                                                  | Every session, for discovery.                                                                   | Keep; give real short descriptions; leave out the never-deferred Pia tools |
| `tool_discovery`                                                                                                                   | Every session.                                                                                  | Shorten (about 50 tokens)                                                  |
| `task_focus`                                                                                                                       | Task sessions.                                                                                  | Keep                                                                       |
| Lazy guides                                                                                                                        | Only after their tool loads.                                                                    | Keep lazy; place them last (cut 3)                                         |
| `artifacts` guide                                                                                                                  | When artifacts are made. 1222 tokens is the largest guide.                                      | Shorten                                                                    |
| `pia`                                                                                                                              | Every Pia turn. Repeats 2 `guidelines` bullets (brevity, destructive commands).                 | Shorten                                                                    |
| `pia_inbox`                                                                                                                        | Every Pia turn that has notes.                                                                  | Keep                                                                       |
| `pia_rules`                                                                                                                        | Every Pia turn. The STE rule block (377 tokens) applies only when Pia writes to an agent.       | Shorten                                                                    |
| `pia_github`                                                                                                                       | Pia turns about repositories.                                                                   | Keep, or load with `repo_watch`                                            |
| `pia_shared`, `pia_environment`                                                                                                    | Every Pia turn.                                                                                 | Keep                                                                       |
| `read`, `write`, `bash`, `ls`, `tool_search`, `tool_load`                                                                          | Every session.                                                                                  | Keep                                                                       |
| `note_search`, `note_load`                                                                                                         | Start of most tasks (the `memory` rule).                                                        | Keep                                                                       |
| Pia `sessions`, `session_read`, `session_start`, `session_send`, `session_follow`                                                  | Most Pia turns.                                                                                 | Keep                                                                       |
| Pia `repo_watch`, `session_watch_pr`, `session_schedule`, `session_model`, `approvals`, `inbox`, `session_stop`, `session_archive` | Some Pia turns.                                                                                 | Load only when needed (deferred)                                           |
| Once-loaded tools in Pia (`browser`, `ink_*`, `edit`, …)                                                                           | The turn that loaded them.                                                                      | Drop at compaction or Start fresh                                          |

## Cache effect

Pi Durable sends only changed sections, so the prompt is stable unless a part below changes. On models without mid-conversation system messages (all local `openai-completions` models), each change rewrites the first system message from that section on, so the prompt cache breaks from there. On Claude and GPT-5.4 or later, each change adds a small update in place, and the cache holds.

| Part                                                                               | Changes when                                                                                           | Effect                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A lazy guide that appears** (`browser`, `schedules`, `subagents`, `codemode`, …) | A `tool_load` of its tool.                                                                             | **Worst.** The guide's place is in the middle (install order), so `planSections` cannot append it: it removes every section and re-adds all of them (about 5600 Qwen tokens). In the stored history: 82 such events in 47 conversations; after entry `155000`, 7 of 36 conversations had one. Loads that did it: `browser` 24, `schedule` 10, `subagent` 7, `codemode` 5. |
| Tool order                                                                         | A loaded tool that the registry orders before an offered tool, or a changed declaration in the middle. | `planTools` removes all tools and re-adds all. Seen 6 times (for example `note_search` and `note_load` between `bash` and `ls`).                                                                                                                                                                                                                                          |
| `codemode`                                                                         | Each `tool_load` while `codemode` is loaded: it lists the loaded tool names.                           | A small update; on local models, a prefix rewrite from `codemode` on.                                                                                                                                                                                                                                                                                                     |
| `subagents`                                                                        | A model's sign-in state changes (`problemOf`), or the owner edits the subagent model list.             | Can change between any 2 requests.                                                                                                                                                                                                                                                                                                                                        |
| `pia_inbox`                                                                        | A note arrives or is handled.                                                                          | Can change each Pia turn. It is in the middle of the Pia sections.                                                                                                                                                                                                                                                                                                        |
| `pia_environment`                                                                  | The date changes (daily).                                                                              | Once per day.                                                                                                                                                                                                                                                                                                                                                             |
| `memory`                                                                           | The note count changes (a note is saved or approved).                                                  | Rare.                                                                                                                                                                                                                                                                                                                                                                     |
| `available_tools`                                                                  | A module is turned on or off, or reloaded.                                                             | Rare.                                                                                                                                                                                                                                                                                                                                                                     |
| `ink_board`                                                                        | Its `problem` status text changes.                                                                     | Rare.                                                                                                                                                                                                                                                                                                                                                                     |
| `project_context`, `skills`                                                        | A file on disk changes (re-read after 30 s).                                                           | Rare, but common while someone edits `AGENTS.md`.                                                                                                                                                                                                                                                                                                                         |
| `environment`                                                                      | Never (the date is off unless `PI_POCKET_PROMPT_DATE=1`).                                              | None.                                                                                                                                                                                                                                                                                                                                                                     |
| Everything else                                                                    | Only with a code edit.                                                                                 | None in normal use.                                                                                                                                                                                                                                                                                                                                                       |

## Ranked cuts

Savings are Qwen tokens per request. "N" is a normal session, "P" is Pia.

| #   | Cut                                                                                                                                                                                                                                                                                                                                                       |                                           Saved per request | Risk                                                                                                  | Work                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------: | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Pia: drop once-loaded tools at compaction and Start fresh.** Reset Pia's `modelTools` to its base set. The 9 tools of case 2 and their 2 guides go.                                                                                                                                                                                                     |                                                P about 2900 | Medium: Pia calls `tool_load` again when it needs one (1 extra step).                                 | Medium: in `src/server/pip.ts` or the compaction path; check Pi Durable `modelTools` semantics.                                                                                  |
| 2   | **Pia: defer rare session tools.** Make `NEVER_DEFERRED` cover only `sessions`, `session_read`, `session_start`, `session_send`, `session_follow`. Defer `repo_watch` 507, `session_schedule` 254, `inbox` 205, `session_watch_pr` 197, `session_model` 156, `approvals` 91, `session_archive` 73, `session_stop` 54. Give each a real short description. |                               P about 1260 (net about 1200) | Medium: Pia must load before a watch, a stop, or an approval. `pia_github` and the catalog name them. | Small: `src/server/local-tools.ts`, `SHORT_DESCRIPTIONS`.                                                                                                                        |
| 3   | **Place lazy guides last.** Make `policy` render the lazy guides after `task_focus` (or as one appended section in load order), so a new guide is appended and not a full re-send.                                                                                                                                                                        | 0 per request; about 5600 per tool load that brings a guide | Low.                                                                                                  | Small: `src/server/local-tools.ts`. The same fix makes cut 4 safe.                                                                                                               |
| 4   | **Lazy `ink_board`.** Add `ink-board` to `LAZY_GUIDES`. Put a 1-line hint in the `ink_open` short description ("Open a board to mark up output").                                                                                                                                                                                                         |                                           N and P about 480 | Low: the agent can miss an `ink_open` offer when the owner asks to review output.                     | Trivial, after cut 3.                                                                                                                                                            |
| 5   | **Compact `skills`.** In `prompt.ts`, write the list as `- name: description (~/path)` and not as XML with absolute paths.                                                                                                                                                                                                                                |                             N and P about 450 (1336 to 888) | Low to medium: skill matching uses the same names and descriptions.                                   | Small: a local formatter in `src/server/extensions/prompt.ts`. The owner can also set `disable-model-invocation` on the 12 marimo skills (about 1046 more), which needs no code. |
| 6   | **Pia trims.** Shorten `pia_rules` (the STE block 377 to about 150, other rules about 150 less). Leave out `inbox-notes` (101) and the STE bullet of `guidelines` (201) in Pia. Drop the 2 `pia` bullets that `guidelines` repeats (about 60).                                                                                                            |                                                 P about 740 | Low to medium: the STE rules shape Pia's messages to agents; test the output.                         | Small: `src/server/extensions/pip.ts`, `prompt.ts`, `inbox-notes.ts`.                                                                                                            |
| 7   | **Move the STE bullet out of `guidelines`.** Pia already writes `[via Pia]` on each message. Put a short STE request in that message (Pia's rules already say to ask for STE), and keep 1 short line in `guidelines`.                                                                                                                                     |                                                 N about 170 | Medium: linked sessions and subagents also send markers; each sender must add the request.            | Small to medium: `prompt.ts`, `pip.ts`, `linked-sessions.ts`.                                                                                                                    |
| 8   | **Shorten `pocket_docs`.** Keep the 3 paths and 1 rule (read only for questions about Pia).                                                                                                                                                                                                                                                               |                        N and P about 270 (371 to about 100) | Low: `docs/index.md` lists the guides.                                                                | Trivial: `docs()` in `prompt.ts`.                                                                                                                                                |
| 9   | **Real catalog descriptions; trim `tool_discovery`.** Give each tool a real `shortDescription`. Leave the never-deferred Pia tools out of the catalog (they are stable, so the cache holds). Shorten `tool_discovery` to about 50 tokens.                                                                                                                 |                                     N about 50; P about 180 | Low.                                                                                                  | Small: `local-tools.ts`.                                                                                                                                                         |
| 10  | **Shorten the `artifacts` guide.**                                                                                                                                                                                                                                                                                                                        |                         About 500 when `artifact` is loaded | Low to medium.                                                                                        | Small: `artifacts.ts`.                                                                                                                                                           |
| 11  | **Move `pia_inbox` last among the Pia sections.**                                                                                                                                                                                                                                                                                                         |        0 per request; fewer prefix rewrites on local models | Low.                                                                                                  | Trivial: `pip.ts`.                                                                                                                                                               |
| 12  | **Shorten `inbox-notes`** (about 40 tokens).                                                                                                                                                                                                                                                                                                              |                                                  N about 60 | Low.                                                                                                  | Trivial.                                                                                                                                                                         |

Totals if every cut of low or medium risk is done: a normal session goes from about 4861 to about 3400 Qwen tokens (about 30% less). A Pia conversation goes from about 11 200 to about 5000 (about 55% less).

Not proposed: cutting `project_context` (the owner's `AGENTS.md`), `preamble`, `environment`, `memory`, or the base file tools. They are needed in every turn.

## Out of scope

- The `claude-code` providers (Pia's model here) add Claude Code's own system text and send the tools through MCP. This report does not measure that part.
- The cache keeper (`src/server/cache-keeper.ts`) keeps a prompt warm for 5 minutes. It does not change these sizes.

## Design: a lean start prompt under 1500 tokens

Goal (from the owner): a normal coding session starts with fewer than 1500 tokens, prompt and tool schemas together. Pia keeps its larger prompt. Branch `feat/lean-start-prompt`, worktree `/home/ttian7/Dev/pi-pocket-lean-prompt`. `PI_POCKET_LEAN_PROMPT=off` restores the full prompt.

### Result

| Measure                                                                                                                 |     Before |    After |
| ----------------------------------------------------------------------------------------------------------------------- | ---------: | -------: |
| Real first request, local `qwen3.8-27b-ud-iq3-xxs` through `openai-completions` (`usage.input`, chat template included) |       5457 | **1272** |
| Same payload sent again (cache read)                                                                                    |       5453 |     1268 |
| Qwen tokenizer, sections + compact tool JSON                                                                            |       4963 |      798 |
| Qwen tokenizer, sections + tools in the wire form (`{"type":"function",…}`)                                             | about 5400 |     1033 |

Method: a throwaway app from the worktree (`test/helpers.ts`, temporary data folder) with the modules of this server on (`ink-board`, `inbox-notes`, `memory`, `browser`, `schedules`, `codemode`, `restart`), the owner's 14 real skills, and this repository's `AGENTS.md`. The first model request was captured, turned into the exact `openai-completions` payload by pi-ai's `streamSimple`, and sent to the local inference router with `max_tokens: 1`. The difference between 1033 and 1272 is the chat template of the model.

### Each part

Tokens are Qwen3.6, compact JSON for tools.

| Part              |       Before |   After | Change                                                                                                                                         |
| ----------------- | -----------: | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `preamble`        |          127 |     113 | Shorter: 1 line about Pia and Pi Durable, the phone, `[from: Name]`, destructive steps, images, and the ASD-STE100 rule for `[via …]` messages |
| `guidelines`      |          389 |       0 | Removed; the needed lines are in `preamble`                                                                                                    |
| `pocket_docs`     |          387 |       0 | Removed; a pointer in `on_demand`                                                                                                              |
| `project_context` |          730 |       0 | On demand: a pointer to each `AGENTS.md` path in `on_demand`                                                                                   |
| `skills`          |         1336 |       0 | On demand: `tool_search` also finds skills                                                                                                     |
| `on_demand` (new) |            0 |      79 | New: the `AGENTS.md` paths and Pia's `docs/index.md`                                                                                           |
| `environment`     |           27 |      25 | Stays                                                                                                                                          |
| `memory`          |          122 |       0 | On demand: comes with the `memory` tool; the "search notes first" rule is in the `note_search` description                                     |
| `inbox-notes`     |          101 |       0 | On demand: comes with `inbox_note`                                                                                                             |
| `ink_board`       |          506 |       0 | On demand: comes with an `ink_*` tool                                                                                                          |
| `available_tools` |          301 |      83 | Shorter: names of the tools not loaded yet, in 1 line, plus "tool_search also finds skills"                                                    |
| `tool_discovery`  |          101 |       0 | Removed; the `tool_search` and `tool_load` descriptions carry it                                                                               |
| `task_focus`      |           29 |      29 | Stays                                                                                                                                          |
| `read`            |          150 |      63 | Shorter schema                                                                                                                                 |
| `write`           |           83 |      40 | Shorter schema                                                                                                                                 |
| `edit`            | 0 (deferred) |      89 | Moved to the start set, short schema                                                                                                           |
| `bash`            |          111 |      56 | Shorter schema                                                                                                                                 |
| `note_search`     |          133 |      68 | Shorter schema; carries the "search at the start of a task" rule                                                                               |
| `note_load`       |           78 |      50 | Shorter schema                                                                                                                                 |
| `ls`              |           58 |       0 | On demand (`bash` covers it); `rg` too                                                                                                         |
| `tool_search`     |           98 |      45 | Shorter schema; also searches skills                                                                                                           |
| `tool_load`       |           96 |      58 | Shorter schema                                                                                                                                 |
| **Total**         |     **4963** | **798** |                                                                                                                                                |

The lazy guides of the earlier report (`browser`, `schedules`, `subagents`, `artifacts`, `codemode`, `background_tasks`, `agent-teams`, `design_mode`) were on demand already. They stay on demand.

### What changed in the code

- `src/server/extensions/prompt.ts`: `LEAN_PREAMBLE`, `leanPointers`, the `on_demand` section. In a normal session, `guidelines`, `pocket_docs`, `project_context`, and `skills` render nothing. A Pia chat (`piaFile`) keeps all of them.
- `src/server/local-tools.ts`:
    - `LEAN_DECLARATIONS` and `leanDeclaration`: short model-facing schemas for the base tools. Each lean schema accepts a subset of the original one. The original `execute` runs unchanged.
    - `edit` joins the start set, and `ls` and `rg` leave it (`LEAN_START_DEFERRED`).
    - `ink-board`, `pocket-inbox-notes`, and `pocket-memory` join the lazy guides (`LEAN_LAZY_GUIDES`). Memory's guide waits for the `memory` tool, not for the note tools. A Pia chat keeps these 3 guides from the start.
    - `matchSkills`, and skills in the `tool_search` result (name, description, `SKILL.md` path).
    - `available_tools` becomes 1 line of names; `tool_discovery` renders nothing. A Pia chat keeps both as before.
- `src/server/app.ts`: hands `this.skills(cwd)` to `localToolRegistry`.
- `test/helpers.ts`: older tests run with `PI_POCKET_LEAN_PROMPT=off`, because they check the full prompt text.
- `test/lean-prompt.test.ts` (new): the start set, the removed sections, the `AGENTS.md` pointer, skills in `tool_search`, a guide that comes with its tool, a lean schema that runs the original tool, Pia's full sections, and the skill ranking.
- `npm run check`, `npm run lint`, and `npm test` pass (1035 tests, 0 failures).

### What a normal session loses at the start, and how it gets it back

| Lost at the start                                                                                                    | How the agent gets it back                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The text of the project's `AGENTS.md` (code style, test commands, restart rules)                                     | `on_demand` gives each path with "read before you change files"; the agent reads it with `read`                                  |
| The skill list                                                                                                       | `tool_search` with words of the task returns matching skills and their `SKILL.md` paths; `available_tools` says so               |
| Pia's documentation map                                                                                              | `on_demand` points to `docs/index.md`                                                                                            |
| Guideline details: `read`/`edit` over `cat`/`sed`, clear file paths, attachment paths, the full ASD-STE100 rule list | The short `preamble` keeps the main rules; the `[via …]` message comes from Pia, whose own rules ask for ASD-STE100 in each task |
| The durability text (restart, `interrupted` errors)                                                                  | The `interrupted` tool error explains itself (`Tool … was interrupted and may have partially run`)                               |
| Memory rules (notes are data, can be out of date, saving needs approval)                                             | `note_search` says that notes can be out of date; the full rules come with the `memory` tool                                     |
| Ink board and inbox note rules                                                                                       | They come with an `ink_*` tool or `inbox_note`                                                                                   |
| `ls` and `rg`                                                                                                        | `bash`, or `tool_load`                                                                                                           |
| Full tool descriptions (output limits, spill files, edit merging rules)                                              | Short versions keep the limits; tool results and errors explain the rest                                                         |

### Notes and risks

- The tool declarations come from 1 registry view for every conversation, so Pia also gets the short schemas of the base tools. Pia keeps all its sections. The saving in Pia is about 400 tokens.
- Moving `edit` into the start set costs 89 tokens, but the lean prompt has no "use edit for precise changes" line, and a session without `edit` uses `write` or `sed`.
- The agent can skip the `AGENTS.md` pointer. This is the main risk. A test with real tasks must check it. An option is to keep a short `AGENTS.md` inline when it is small (for example under 300 tokens).
- Section order: `on_demand` sits before `environment`; a lazy guide still lands in the middle when it loads (cut 3 of the earlier report is still open).

### Restart

The change is in `src/server/local-tools.ts` and `src/server/app.ts`, so the running Pia server must restart to use it after a merge. The measurements above ran in a throwaway app from the worktree; they did not need a restart. The branch is not merged.
