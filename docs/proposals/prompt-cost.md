# Proposal and roadmap: the cost of the start prompt

Status: **in progress.** Branch `feat/lean-start-prompt` (worktree `~/Dev/pi-pocket-lean-prompt`) implements phase 0. It is not merged. This document is the only handover: a new session must be able to execute the roadmap from it alone.

## 1. Goal and history

1. **Research (2026-11-07, commit `d6c573b4`).** The first task measured the start prompt and the tool schemas and proposed trims, with no code change. A normal session started with 4861 Qwen tokens; Pia started with 11 187. (History note: this document then had the status "research only. No code changed." The branch now changes code.)
2. **New goal (owner, Tina).** A normal coding session must start with fewer than 1500 tokens, prompt and tool schemas together. Design rules:
    - 1 short line about the harness ("Pia, built on Pi Durable"); the agent does not need the internals.
    - Then the tool schemas carry the meaning.
    - Heavy sections and the skills list leave the start prompt.
    - Rare content loads on demand.
    - Pia (the owner's assistant) can add more tools later, and Pia keeps a larger prompt.
3. **Phase 0 built.** The worktree implements the lean start prompt. A real first request measured **1272** input tokens against **5457** for the full prompt (local `qwen3.8-27b-ud-iq3-xxs`). 1035 tests passed.
4. **Codemode proposed.** Code mode becomes the agent's general workspace and the main route to optional tools, with no change to the prompt prefix after the first request (phase 4).
5. **Prompt text in Markdown files.** The owner prefers prompt text in Markdown files, loaded by the TypeScript code, not in TypeScript strings. TypeScript strings are accepted for now (phase 3; open question Q7).

## 2. Target architecture

This is the final shape after all phases. Each phase moves toward it.

**The start prompt (normal session), in this order:**

1. `preamble`: 1 or 2 sentences. Where the agent runs (Pia, built on Pi Durable), short replies for a phone, `[from: Name]`, say before a destructive step, never work around a blocked call, images as `![alt](/path.png)`, and ASD-STE100 for `[via …]` messages.
2. `on_demand`: pointers only. The path of each `AGENTS.md` with "read before you change files", and Pia's `docs/index.md`.
3. `environment`: the working folder and the platform. No date.
4. `task_focus`.
5. Nothing else. No skills list, no guides, no catalog with descriptions.

**The start tool set:** `read`, `write`, `edit`, `bash`, `codemode`, `note_search`, `note_load`, each with a short schema. After phase 4, `tool_search` and `tool_load` are gone: `searchTools()` and `describeTool()` inside a script do their work.

**Tool discovery:** the agent writes a `codemode` script. `searchTools(query)` finds tools and skills; `describeTool(name)` returns the TypeScript signature and the guide; the script then calls `tools.<name>(…)`. A one-off use stays one-off: the call and its result are only in the `codemode` result.

**Note and skill discovery:** `note_search` at the start of a task and before an action that a note can cover. Skills come from `searchTools()` (or `tool_search` until phase 4). Project instructions come from the `AGENTS.md` pointer. Pia's docs come from the `docs/index.md` pointer.

**Guides that come with tools:** the first result of an optional tool in a session carries its guide once, as an appended tool result. No guide is a system prompt section.

**The cache rule:** after the first request of a conversation, the system prompt and the tool list do not change. Only appended messages and tool results add text. A change that cannot wait (a new native tool) waits for a compaction, an expired cache, or a reset. Every section text is fixed (no counts, no lists of loaded tools, no date).

**Pia:** keeps a larger prompt (its own preamble, rules, GitHub text, shared `AGENTS.md`), with phase 2 cuts. Pia follows the same cache rule.

**Prompt text:** in Markdown files under `src/server/prompts/`, loaded by the TypeScript code (phase 3).

## 3. How to trim

### 3.0 Method

- **Real text.** Pia stores each rendered section and each tool declaration in `pi.system` entries (`sections`, `toolsAdded`, `toolsRemoved`). Folding them in order (and starting again at `pi.compaction` and `pi.reset`) gives exactly what the model gets. Case 1 is this session (conversation `164404`, folder `/home/ttian7/Dev/pi-pocket`). Case 2 is Pia's conversation `3` after its last compaction (entry `163638`, then `164388`).
- **Memory.** The running server started before the memory host existed, so case 1 has no `memory` section and no note tools. The case adds them as the code at `d6c573b4` renders them (`memory` 501 chars, `note_search`, `note_load`).
- **Case 3.** A throwaway app (`test/helpers.ts` with a temporary data folder and the scripted model) with every built-in module on, and with `PI_POCKET_TOOL_DISCOVERY=on`. It rendered every section with every deferred tool loaded. The case uses the same `skills` and `project_context` as case 1. It does not include Pia's own tools or the owner's `tt-*` modules.
- **Tokenizers.** Qwen3.6 (`Qwen/Qwen3.6-35B-A3B` `tokenizer.json`, the family of the local models) and `o200k_base` (GPT). No Claude tokenizer is available offline. Claude counts are often 10 to 20% higher than o200k for English and JSON. Characters divided by 4 is close: 4977, 11 814, and 14 847.
- **Scripts.** They are in `/tmp/pcost/scripts/` (temporary, not in the repository). They read `~/.pi-pocket/pocket.sqlite` read-only.

**The real request.** A throwaway app from the worktree (`test/helpers.ts`, temporary data folder) captures the first model request. pi-ai's `streamSimple` turns it into the exact `openai-completions` payload, which goes to the local inference router (`http://127.0.0.1:8095/v1`, key from `~/Dev/inference-router/manage key`) with `max_tokens: 1`. The model's `usage.input` is the real number. It includes the chat template (about 240 tokens on this model). Scripts: `/tmp/pcost/scripts/dump-lean.ts`, `dump-pia.ts`, `payload.ts`, `parts.py` (temporary; a new session writes them again from this description).

### 3.1 Where each part comes from

How the parts reach the model: Pi Durable renders each selected extension's sections in order before each request (`planSystemEntries` in `pi-durable/dist/harness/prompt.js`). A section is wrapped as `<key>…</key>` unless it has `tag: false`. Only the changed sections go in a new `pi.system` entry. The provider then gets them in one of 2 ways (`resolveTranscript` in `pi-ai/dist/utils/transcript.js`):

- Models with `supportsMidConvoSystemMessages` (Claude 4.8 and later, GPT-5.4 and later): later changes go as small system updates in place.
- All other models, including every local `openai-completions` model: `collapseSystemMessages` folds every change into the first system message. Any change rewrites the prompt prefix from that section on.

#### 3.1.1 Sections

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

#### 3.1.2 Tool schemas

- Which tools go from the start: `BASE` in `src/server/local-tools.ts` (`read`, `write`, `bash`, `ls`, `rg`, `tool_search`, `tool_load`, `note_search`, `note_load`). `rg` is in only when `hasRipgrep()` finds it; this machine has none. Every other tool is wrapped `deferred: true` in `policy`, except the tools of `NEVER_DEFERRED` (`pocket-pip`): all Pia session tools go from the start in Pia.
- `read`, `write`, `edit`, `bash`: pi-coding-agent's built-in tools.
- `ls`, `tool_search`, `tool_load`, `rg`: `directoryTool`, `discoveryTool`, `loadTool`, `ripgrepTool` in `src/server/local-tools.ts`.
- `note_search`, `note_load`, `memory`: `createMemory` in `src/server/extensions/memory.ts`.
- `sessions`, `session_*`, `approvals`, `inbox`, `repo_watch`: `createPip` in `src/server/extensions/pip.ts`.
- Others: `artifact` and `artifact_inline` (`artifacts.ts`), `browser` (`browser.ts`), `subagent` (`subagents.ts`), `team` (`agent-teams.ts`), `schedule` (`schedules.ts`), `background` (`background.ts`), `codemode` (`codemode.ts`), `inbox_note` (`inbox-notes.ts`), `watch_pr` (`updates.ts`), `ask_someone` (`ask-someone.ts`), `request_restart` (`restart.ts`), `design_*` (`design.ts`), `ink_*` (`ink-board.ts`), `provider_usage` (`tt-usage.ts`, a drop-in of the owner).
- A loaded tool stays in `modelTools` on the branch, also after a compaction and after Start fresh (see entry `159949` after reset `159944`).

### 3.2 Cache effects

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

**How a section change reaches the provider.** Models with `supportsMidConvoSystemMessages` (Claude 4.8 and later, GPT-5.4 and later in pi-ai's model data) get each change as a small system update in place, and tool changes as `tool_addition` blocks: the cache holds. Every other model, including every local `openai-completions` model, gets `collapseSystemMessages`: every change is folded into the first system message, so the prefix changes from that section on.

**Trimming old tool output.** The cache is a prefix. To omit or replace an old tool result at position k keeps the cache before k and computes the rest again once. Pi Durable supports `omit` and `replace` edits on entries; compaction is the extreme case. Trim in batches, and only when the output is large and many turns remain. Better: keep large output out of the context (code mode filters it).

### 3.3 Rules for each fate

| Fate          | Rule                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stays**     | Needed on most turns of most sessions, and short: `environment`, `task_focus`, the base file tools.                                                                                                          |
| **Shorter**   | Needed often, but the text explains more than the model needs: `preamble`, the base tool schemas. A short schema must accept a subset of the original schema, so that the original `execute` runs unchanged. |
| **On demand** | Needed in some sessions only: skills, `AGENTS.md` text, guides, rare tools. It must have a pointer or a search route that the agent sees at the start.                                                       |
| **Goes away** | Repeated elsewhere, or about the harness internals: `guidelines`, `pocket_docs`, `tool_discovery`.                                                                                                           |
| **Cache**     | A part that changes between requests must be fixed or must leave the prompt. A part that appears later must come as an appended message or tool result, not as a section in the middle.                      |

## 4. Where to trim

### 4.1 Normal session

#### 4.1.1 Result

| Measure                                                                                                                 |     Before |    After |
| ----------------------------------------------------------------------------------------------------------------------- | ---------: | -------: |
| Real first request, local `qwen3.8-27b-ud-iq3-xxs` through `openai-completions` (`usage.input`, chat template included) |       5457 | **1272** |
| Same payload sent again (cache read)                                                                                    |       5453 |     1268 |
| Qwen tokenizer, sections + compact tool JSON                                                                            |       4963 |      798 |
| Qwen tokenizer, sections + tools in the wire form (`{"type":"function",…}`)                                             | about 5400 |     1033 |

Method: a throwaway app from the worktree (`test/helpers.ts`, temporary data folder) with the modules of this server on (`ink-board`, `inbox-notes`, `memory`, `browser`, `schedules`, `codemode`, `restart`), the owner's 14 real skills, and this repository's `AGENTS.md`. The first model request was captured, turned into the exact `openai-completions` payload by pi-ai's `streamSimple`, and sent to the local inference router with `max_tokens: 1`. The difference between 1033 and 1272 is the chat template of the model.

#### 4.1.2 Each part

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

### 4.2 Pia

Measured on the branch: a throwaway app with `pip.ts` on and the same modules and skills, the first request of a Pia chat.

| Measure                                        | Full (`PI_POCKET_LEAN_PROMPT=off`) |         Branch |
| ---------------------------------------------- | ---------------------------------: | -------------: |
| Real first request, local Qwen (`usage.input`) |                               9731 |           9380 |
| Qwen tokenizer, sections + compact tool JSON   |                               8674 |           8336 |
| Sections                                       |                               5531 |           5531 |
| Tools                                          |                     21 tools, 3143 | 21 tools, 2805 |

The Pia sections do not change on the branch. Only the base tool schemas are shorter, because every conversation uses the same tool declarations (phase 0 side effect). This first request has fewer tools than the stored conversation `3` (28 tools, 11 187 tokens in total): that conversation also kept 9 once-loaded tools (see cut 1).

| Part               |         Full | Branch | Fate (target)                                                        |
| ------------------ | -----------: | -----: | -------------------------------------------------------------------- |
| `guidelines`       |          389 |    389 | Phase 2: leave out the STE bullet (201) in Pia                       |
| `pocket_docs`      |          386 |    386 | Keep (Pia answers questions about Pia)                               |
| `skills`           |         1336 |   1336 | Open question Q3: keep, or search                                    |
| `environment`      |           28 |     28 | Stays                                                                |
| `memory`           |          128 |    128 | Stays; fixed text (phase 1)                                          |
| `inbox-notes`      |          101 |    101 | Phase 2: leave out in Pia                                            |
| `ink_board`        |          506 |    506 | Phase 1: on demand                                                   |
| `available_tools`  |          430 |    430 | Phase 2: real short descriptions; no never-deferred Pia tools        |
| `tool_discovery`   |          101 |    101 | Phase 4: goes away                                                   |
| `pia`              |          650 |    650 | Phase 2: drop the 2 bullets that `guidelines` repeats (about 60)     |
| `pia_rules`        |         1009 |   1009 | Phase 2: shorter (STE block 377 to about 150, others about 150 less) |
| `pia_github`       |          307 |    307 | Stays; or comes with `repo_watch`                                    |
| `pia_shared`       |           94 |     94 | Stays (owner content)                                                |
| `pia_environment`  |           66 |     66 | Stays (changes once a day)                                           |
| `pia_inbox`        | 0 (no notes) |      0 | Phase 2: last among the Pia sections (cut 11)                        |
| `read`             |          150 |     63 | Shorter (done)                                                       |
| `write`            |           83 |     40 | Shorter (done)                                                       |
| `edit`             |            0 |     89 | In the start set (done)                                              |
| `bash`             |          111 |     56 | Shorter (done)                                                       |
| `note_search`      |          133 |     68 | Shorter (done)                                                       |
| `note_load`        |           78 |     50 | Shorter (done)                                                       |
| `ls`               |           58 |      0 | On demand (done)                                                     |
| `tool_search`      |           98 |     45 | Shorter (done); phase 4: goes away                                   |
| `tool_load`        |           96 |     58 | Shorter (done); phase 4: goes away                                   |
| `sessions`         |          133 |    133 | Stays                                                                |
| `session_read`     |           95 |     95 | Stays                                                                |
| `session_start`    |          351 |    351 | Stays                                                                |
| `session_send`     |          143 |    143 | Stays                                                                |
| `session_follow`   |           72 |     72 | Stays                                                                |
| `session_model`    |          156 |    156 | Phase 2: deferred (cut 2)                                            |
| `session_stop`     |           54 |     54 | Phase 2: deferred                                                    |
| `session_archive`  |           73 |     73 | Phase 2: deferred                                                    |
| `session_schedule` |          254 |    254 | Phase 2: deferred                                                    |
| `approvals`        |           91 |     91 | Phase 2: deferred                                                    |
| `inbox`            |          205 |    205 | Phase 2: deferred                                                    |
| `repo_watch`       |          512 |    512 | Phase 2: deferred                                                    |
| `session_watch_pr` |          197 |    197 | Phase 2: deferred                                                    |

### 4.3 Research measurements (2026-11-07)

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

Tokens are Qwen3.6 / o200k. Section sizes include their `<key>` tags.

#### 4.3.1 Case 1: normal coding session

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

#### 4.3.2 Case 2: Pia conversation

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

#### 4.3.3 Case 3: most tools

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

### 4.4 Who needs each part (research)

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

### 4.5 Ranked cuts (research)

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

## 5. Tool discovery

### 5.1 Current design (phase 0, the branch)

- **Start set:** `read`, `write`, `edit`, `bash`, `note_search`, `note_load`, `tool_search`, `tool_load`, with short schemas.
- **Catalog:** `available_tools` lists the names of the tools not loaded yet, in 1 line, plus "tool_search also finds skills". No descriptions.
- **`tool_search(query)`:** returns matching tools (name and a description cut at 160 characters) and matching skills (name, description, `SKILL.md` path). It loads nothing.
- **`tool_load(names)`:** adds the tools to `modelTools` with `control.addTools`. They work from the next request on, and stay loaded on the branch, also after a compaction.
- **Guides:** a lazy guide renders as a system prompt section when its tool loads.
- **Costs:** 2 model turns for each new tool (load, then call). Each load changes the tool list, and a guide that appears lands in the middle of the prompt. On local models this rewrites the prefix (about 5600 tokens re-sent; 82 such events in 47 stored conversations).
- **Errors:** a call to a tool that is not loaded fails with the harness error `Tool <name> is not available`. It does not say how to load it.

### 5.2 Proposed design (phase 4)

- **Start set:** `read`, `write`, `edit`, `bash`, `codemode`, `note_search`, `note_load`. `tool_search`, `tool_load`, and `available_tools` go away.
- **Code mode is the workspace**, not only a discovery tool. It batches independent calls (`Promise.allSettled`), chains dependent calls, filters large output so that only the result enters the context, runs loops and small logic, and reaches optional tools.
- **Route to an optional tool:** in a script, `searchTools(query)` finds tools and skills, `describeTool(name)` returns the TypeScript signature and the guide, then `tools.<name>(…)` calls it. 1 model turn. The tool list does not change.
- **Repeated use:** promotion appends the full description once; it does not change the tool list. A native tool change waits for a compaction, an expired cache, or a reset (only local models need the wait).
- **An explicit request ("I need tool X"):** the same as repeated use.
- **Errors that teach** (appended, no cache miss):
    - an unknown or deferred tool: "`tools.ink_open` is not loaded here. Run `await describeTool(\"ink_open\")`."
    - a wrong argument: the error returns the TypeScript signature.
    - the first call of an optional tool: the result carries its guide once.
- **How the agent learns code mode:** a fixed `codemode` description (about 250 to 300 tokens, an estimate) that says when to use it, gives the sandbox rules, and has 1 short example.

### 5.3 Comparison

|                                        | Current (phase 0)                             | Proposed (phase 4)                                          |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Model turns to use a new tool          | 2                                             | 1                                                           |
| Prefix changes after the first request | On each `tool_load`, and when a guide appears | None (only at compaction, cache expiry, or reset)           |
| Start cost (real, local Qwen)          | 1272                                          | about 1100 to 1300 (estimate)                               |
| First call correct                     | High (full schema loaded)                     | Lower; a wrong call returns the signature                   |
| Large intermediate output              | Enters the context                            | Filtered in the script                                      |
| Guard, approvals, plan mode            | Native                                        | Nested calls through `toolHooks` (already used by codemode) |

## 6. Note discovery

| Kind            | Not in the start prompt                                                            | How the agent finds it                                                                                                                                                                                                       | When the agent must search                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory notes    | The notes themselves (also before the branch) and, on the branch, the memory rules | `note_search(query)` returns ids and excerpts; `note_load(ids)` reads whole notes. A read note stays through a compaction.                                                                                                   | At the start of a task, and before an action that a note can cover (a machine fact, a service, a person's preference or rule). The rule is in the `note_search` description. |
| Memory rules    | Notes are data, can be out of date; saving needs approval                          | `note_search` says notes can be out of date; the full rules come with the `memory` tool                                                                                                                                      | Before the agent saves a note                                                                                                                                                |
| Skills          | The skill list (14 skills, 1336 tokens)                                            | `tool_search` (phase 4: `searchTools()`) matches words of the task against skill names and descriptions and returns the `SKILL.md` path; the agent reads it with `read` and resolves relative paths against the skill folder | When a task names a tool, a format, or a workflow (for example "marimo notebook", "PDF", "web search")                                                                       |
| Project context | The `AGENTS.md` text (730 tokens for this repository)                              | `on_demand` gives each path with "read before you change files"                                                                                                                                                              | Before the first change to a file in the project                                                                                                                             |
| Pia's docs      | The documentation map (387 tokens)                                                 | `on_demand` points to `docs/index.md`                                                                                                                                                                                        | When someone asks about Pia itself                                                                                                                                           |

## 7. Lost facts at the start, and how the agent gets each one back

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

## 8. State of the branch

Branch `feat/lean-start-prompt`, based on `d6c573b4`, worktree `~/Dev/pi-pocket-lean-prompt` (its `node_modules` is a symbolic link to the main checkout's; it is not committed).

### 8.1 Done (phase 0)

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

### 8.2 Not done

- Phases 1 to 6 of the roadmap.
- No task run with a real model: the lean prompt is measured for size only, not for behavior.
- The prompt text is still in TypeScript strings.

### 8.3 Known side effects

- **Pia gets the short base tool schemas too.** The tool declarations come from 1 registry view for every conversation. Pia's sections do not change. Pia's real first request goes from 9731 to 9380 tokens.
- `edit` is in the start set (89 tokens); `ls` and `rg` are deferred.
- Older tests run with `PI_POCKET_LEAN_PROMPT=off` (`test/helpers.ts`). Only `test/lean-prompt.test.ts` tests the lean prompt.
- `PI_POCKET_LEAN_PROMPT` is read on each call, so tests can switch it; the server reads it from its environment.
- The lean prompt is the default on the branch (`PI_POCKET_LEAN_PROMPT` unset). See Q5.
- The change is in `src/server/local-tools.ts` and `src/server/app.ts`: the real server must restart after a merge.
- In 1 full test run, `test/mobile-ui.test.ts` ("on a phone, an invite lasts as long as chosen, and the one it replaces ends") failed once. It passed 3 times of 3 alone on the branch, and 2 times of 2 on the base commit. It is a UI timing test, not related to the prompt.

## 9. Execution plan

Each phase is 1 mergeable step, on its own branch from the previous phase. Each phase must pass `npm run check`, `npm run lint`, and `npm test`. Token budgets are Qwen tokens; "real" means `usage.input` of the first request on local `qwen3.8-27b-ud-iq3-xxs`, measured as in section 3. A phase must not change the main checkout until it is reviewed.

### 9.0 Order and reasons

The order differs from the order in the request in 1 point: the controlled experiment comes in 2 parts. A **baseline run** (phase 5a) can run on phase 0 already, because it compares the full prompt with the lean prompt; it shows behavior risks (the `AGENTS.md` pointer, skill discovery) early, before more work builds on them. The **full run** (phase 5b) comes after phase 4, with all 3 arms. The other phases keep the requested order, because each one makes the next one safer: phase 1 fixes the cache before more tools come on demand; phase 2 is independent but small; phase 3 moves text before phase 4 writes new text, so that new text goes into Markdown files from the start.

### Phase 0: lean start prompt (done, this branch)

- **Goal:** a normal session starts under 1500 tokens.
- **Files:** `src/server/extensions/prompt.ts` (`LEAN_PREAMBLE`, `leanPointers`, `on_demand`, `lean`), `src/server/local-tools.ts` (`LEAN_DECLARATIONS`, `leanDeclaration`, `inBase`, `LEAN_START_DEFERRED`, `LEAN_LAZY_GUIDES`, `isPia`, `matchSkills`, `discoveryTool(skills)`, `availableTools`), `src/server/app.ts` (`localToolRegistry(…, (cwd) => this.skills(cwd))`), `test/helpers.ts`, `test/lean-prompt.test.ts`.
- **Budget after:** normal 798 (real 1272); Pia 8336 (real 9380).
- **Tests and checks:** `test/lean-prompt.test.ts` (5 tests); 1035 tests pass; the real request is under 1500.
- **Rollback:** `PI_POCKET_LEAN_PROMPT=off` in the server environment, or revert the commit.
- **Restart:** yes, after the merge.

### Phase 1: a fixed prompt prefix (lazy guides last, fixed section texts)

- **Goal:** no section change in the middle of the prompt after the first request (cut 3). This also makes the phase 0 lazy guides (`ink_board`, `inbox-notes`, `memory`) safe.
- **Files and functions:**
    - `src/server/local-tools.ts`, `policy`: the wraps of the lazy guides return `undefined` in place, and 1 new section `guides`, placed after `task_focus`, renders the loaded guides in load order (the order of `input.agent.tools`). Pi Durable's `planSections` then appends a new guide instead of a remove-all and re-add-all.
    - `src/server/extensions/codemode.ts`, the `codemode` section: a fixed text with no list of loaded tool names.
    - `src/server/extensions/memory.ts`, `render`: no note count ("Notes exist for this project and everywhere").
    - `src/server/extensions/subagents.ts`, `guide`: no sign-in state in the section; the state goes into the `subagent` tool result.
- **Budget after:** normal about 798 (no change); Pia about 8336.
- **Tests and checks:** a new test in `test/local-tools.test.ts`: load `browser`, then `schedule`, and check that each new `pi.system` entry adds 1 section and removes none. A count from the stored history method (section 3.2) on a test run: 0 remove-all events.
- **Rollback:** revert the commit (the old order comes back).
- **Restart:** yes (`src/server/local-tools.ts`). The `codemode.ts`, `memory.ts`, and `subagents.ts` changes reload without a restart.

### Phase 2: Pia cuts (cuts 1, 2, 6, 11)

- **Goal:** a smaller and more stable Pia prompt.
- **Files and functions:**
    - Cut 1: drop once-loaded tools at compaction and Start fresh. Reset Pia's `modelTools` to its base set. Where: the reset path in `src/server/pip.ts` and the compaction path; check Pi Durable's `modelTools` semantics (`AgentState.modelTools`) first.
    - Cut 2: `src/server/local-tools.ts`, `NEVER_DEFERRED`: only `sessions`, `session_read`, `session_start`, `session_send`, `session_follow` stay offered. Defer `repo_watch` 512, `session_schedule` 254, `inbox` 205, `session_watch_pr` 197, `session_model` 156, `approvals` 91, `session_archive` 73, `session_stop` 54. Add their short descriptions to `SHORT_DESCRIPTIONS`.
    - Cut 6: `src/server/extensions/pip.ts`, `RULES` (STE block 377 to about 150, other rules about 150 less) and `piaPreamble` (drop the 2 bullets that `guidelines` repeats, about 60); `src/server/extensions/prompt.ts` (no STE bullet of `guidelines` in Pia, 201); `src/server/extensions/inbox-notes.ts` (no section in Pia, 101).
    - Cut 11: `src/server/extensions/pip.ts`: `pia_inbox` last among the Pia sections.
- **Budget after:** Pia about 8336 − 1542 (cut 2) − about 740 (cut 6) ≈ 6050 at the start, plus about 2900 less after a compaction in a long Pia chat (cut 1). Normal session: no change.
- **Tests and checks:** `test/pip.test.ts` (update the ASD-STE100 test to the shorter text: Pia still asks each session to answer in ASD-STE100); a test that a deferred Pia tool (for example `repo_watch`) loads and runs; a test that Start fresh offers only the base set. A manual check: 3 Pia tasks (start a session, watch a repository, approve a call).
- **Rollback:** revert the commit.
- **Restart:** yes (`src/server/local-tools.ts`, `src/server/pip.ts`).

### Phase 3: prompt text in Markdown files

- **Goal:** prompt text lives in Markdown files, which the owner can read and edit; the TypeScript code loads them.
- **Files and functions:**
    - New folder `src/server/prompts/` with 1 file for each text: `preamble.md`, `preamble-lean.md`, `guidelines.md`, `pocket-docs.md`, `pia-preamble.md`, `pia-rules.md`, `pia-github.md`, the guides (`browser.md`, `schedules.md`, `ink-board.md`, …), and the tool descriptions that are prose (`codemode.md`).
    - New `src/server/prompt-text.ts`: `promptText(name, vars)` reads a file once (and again when its mtime changes), and replaces `{name}` placeholders (for example `{code}`, `{dataDir}`, `{person}`).
    - Each module that has a constant text uses `promptText`.
    - `docs/customizing.md` and `docs/map.md`: say where the texts are.
- **Budget after:** no change (the same texts).
- **Tests and checks:** a test that each rendered section is the same as before the move (snapshot of the rendered prompt for a normal session and for Pia); a test that a missing file fails at startup with a clear error; `node --check` is not needed (no web change).
- **Rollback:** revert the commit.
- **Restart:** yes for texts used by `src/server/**` outside `extensions/`; the extension modules reload. A text file edit itself must not need a restart (mtime check).
- **Open:** whether the owner can override a text from `~/.pi-pocket/` (Q7).

### Phase 4: code mode as the workspace

- **Goal:** the target architecture for tool discovery (section 5.2): no prefix change after the first request.
- **Facts found in the code (2026-11-08):**
    - `codemode` is not in `BASE` (`src/server/local-tools.ts`). It starts deferred and needs `tool_load`.
    - Scripts cannot call deferred tools. The sandbox gets only `agent.tools` (`src/server/extensions/codemode.ts`: `agent.tools.filter((tool) => tool.name !== CODEMODE_TOOL)`). Pi Durable's own codemode also leaves deferred tools out of its list.
    - Pia's `codemode` description (`DESCRIPTION`) does not say when to use code mode, does not name `searchTools()` or `describeTool()`, and has no example. The "when" text is in the lazy `codemode` section, which changes on each tool load.
    - The `codemode` schema costs 281 Qwen tokens.
- **Changes:**
    1. Put `codemode` in the start set. Remove `tool_search`, `tool_load`, and `available_tools`: `searchTools()` and `describeTool()` inside a script do the same work.
    2. Build the sandbox from `agent.callable`, so that scripts can call deferred tools. Nested calls already go through `toolHooks`, so Lancet Guard and plan mode still apply.
    3. Write a fixed `codemode` description (about 250 to 300 tokens, an estimate) that gives the uses above, the sandbox rules, and 1 short example:
        ```js
        // Read 3 files in parallel; return only the matching lines.
        const r = await Promise.all(["a.ts", "b.ts", "c.ts"].map((p) => tools.read({ path: p })));
        return r.flatMap((t) => t.split("\n").filter((l) => l.includes("TODO")));
        ```
    4. Remove the lazy guide sections. The first result of an optional tool in a session returns its guide once, as an appended tool result.
    5. Make the remaining sections fixed: the `codemode` section stops listing loaded tool names; `memory` stops showing the note count.
    6. Add `skill_search` as a script-only tool (`callers: ["tools"]`). Optionally make `note_search` and `note_load` script-only too (saves about 118 tokens; the "search notes first" habit can get weaker).
    7. Make errors teach: an unknown tool, a wrong argument, or a first call returns the signature or the guide.
    8. Promotion without a cache miss: repeated use and an explicit request append the full description once and do not change the tool list. A native tool change waits for a compaction, an expired cache (`cache-keeper.ts`), or a reset. Claude 4.8 and later and GPT-5.4 and later append tool changes natively (`tool_addition`), so only local models need the wait.

    9. Estimated real first request: about 1100 to 1300 tokens (not measured).
- **Files and functions:** `src/server/local-tools.ts` (`BASE`, `policy`, `availableTools`, remove `discoveryTool` and `loadTool` from the start set), `src/server/extensions/codemode.ts` (`DESCRIPTION`, the sandbox tool list from `agent.callable`, the `codemode` section, teaching errors in `nested`), a new script-only `skill_search` tool (in `local-tools.ts`, `callers: ["tools"]`), the guide-with-first-call logic (a hook on tool results, or a wrap of each optional tool's `execute`), `test/codemode.test.ts`, `test/local-tools.test.ts`, `test/lean-prompt.test.ts`.
- **Budget after:** normal about 1100 to 1300 real (estimate); Pia about the phase 2 budget plus `codemode` (about 280) minus `tool_search` and `tool_load` (103).
- **Tests and checks:** a script calls a deferred tool; a script finds a skill with `searchTools()`; an unknown tool returns the teaching error; the first call of `browser` returns its guide once and the second call does not; Lancet Guard blocks a nested call as it blocks a direct call; plan mode blocks a nested write; after 5 tool uses, the `pi.system` entries after the first request are empty (no prefix change).
- **Rollback:** a switch `PI_POCKET_CODEMODE_START=off` that brings back `tool_search` and `tool_load` (phase 0 behavior), or revert.
- **Restart:** yes.

### Phase 5: controlled experiment

- **5a, baseline (can run now, on phase 0):** arms A (full prompt, `PI_POCKET_LEAN_PROMPT=off`) and B (lean prompt).
- **5b, full (after phase 4):** arms A, B, and C (code mode as the workspace).
- Models: local `qwen3.8-27b-ud-iq3-xxs` and 1 strong model (Claude or GPT, see Q6), temperature 0, 3 runs per task per arm, in throwaway apps.
- Tasks: mark up a PDF (`ink_open`, 1 use); make a marimo notebook (skill discovery); set a reminder (`schedule`, 1 use); change Pia's code (read `AGENTS.md`); test a page with `browser` 5 times (repeated use).
- Metrics: success; model turns; total input tokens; cache-read tokens; prefill seconds; wrong or retried calls; the share of tasks where the agent uses `codemode` without a hint; the share where it finds an optional tool with `searchTools()`; script errors; cache misses after the first request (target: about 0).
- **Files:** a new script `test/experiments/prompt-arms.ts` (not part of `npm test`), which starts a throwaway app for each arm with the real model, runs each task, and writes 1 JSON line per run; a results table in this document.
- **Budget:** no change.
- **Acceptance:** a decision table with the metrics for each arm; the raw JSON in `docs/proposals/prompt-cost-results/` (or outside the repository if it is large).
- **Rollback:** not needed (no product change).
- **Restart:** no (throwaway apps only; never the real server).

### Phase 6: the decision on the default

- **Goal:** decide if the lean prompt (phase 0 to 4) is the default for all normal sessions.
- **Criteria (recommended):** arm C (or B) succeeds on at least as many tasks as arm A; the `AGENTS.md` file is read before the first change in every run of the Pia code task; skills and optional tools are found in at least 2 of 3 runs of each task; no task needs more than 2 model turns more than arm A.
- **Files:** `src/server/extensions/prompt.ts` and `src/server/local-tools.ts` (the default of the switch); `docs/features.md` and `docs/customizing.md`; `docs/release-notes.md`; optionally an app setting (Q4).
- **Budget:** as phase 4.
- **Tests:** older tests run on the new default, or keep `PI_POCKET_LEAN_PROMPT=off` with a reason.
- **Rollback:** the switch, or a setting.
- **Restart:** yes.

## 10. Roadmap

| Phase                            | Depends on  | Size            | Risk                                                | Status                                       |
| -------------------------------- | ----------- | --------------- | --------------------------------------------------- | -------------------------------------------- |
| 0. Lean start prompt             | —           | Medium          | Medium (behavior not tested)                        | Done on `feat/lean-start-prompt`, not merged |
| 1. Fixed prompt prefix (cut 3)   | 0           | Small           | Low                                                 | Not started                                  |
| 2. Pia cuts 1, 2, 6, 11          | 0 (1 helps) | Medium          | Medium (Pia must load rare tools; STE text quality) | Not started                                  |
| 3. Prompt text in Markdown files | 0           | Medium          | Low (same texts)                                    | Not started; design question Q7              |
| 4. Code mode as the workspace    | 1, 3        | Large           | Medium to high (small models may not use code mode) | Not started; plan in section 9               |
| 5a. Baseline experiment (A, B)   | 0           | Small to medium | Low (no product change)                             | Not started                                  |
| 5b. Full experiment (A, B, C)    | 4           | Medium          | Low                                                 | Not started                                  |
| 6. Default decision              | 5b          | Small           | Medium                                              | Not started                                  |

## 11. Open risks

1. The agent can skip the `AGENTS.md` pointer and change files without the project rules.
2. The agent can miss a skill, because no list is in the prompt. It must search to find one.
3. The agent can miss an optional tool, because `available_tools` gives names only. Names such as `codemode` and `artifact_inline` do not say when to use them.
4. Until phase 1, a lazy guide enters the middle of the prompt when its tool loads. On local models this re-sends about 5600 tokens. Phase 0 adds 3 more lazy guides (`ink_board`, `inbox-notes`, `memory`), so this happens more often until phase 1.
5. Pia also gets the short base schemas (9731 to 9380 real tokens). Pia's sections do not change.
6. A short schema leaves out details (spill file paths, edit merge rules). The agent learns them from tool results and errors.
7. A `[scheduled]` message or a subagent report can arrive while its guide is not loaded. This gap was on `main` too.
8. Small local models may not use code mode, or may write invalid scripts (phase 4).
9. The real server must restart after each merge of phases 0, 1, 2, 4, and 6.

## 12. Open questions, with recommended answers

| #   | Question                                                                                   | Recommended answer (the reviewer can disagree)                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Must a small `AGENTS.md` stay inline, with a pointer only for larger files?                | Yes. Inline when the files together are under 300 tokens; else the pointer. Most projects have a short file, and the pointer is the largest behavior risk. Phase 5a must measure the pointer.                                    |
| Q2  | Is moving `edit` into the start set (89 tokens) and `ls` and `rg` out of it correct?       | Yes. `edit` is used in most coding tasks; without it the agent rewrites whole files or uses `sed`. `bash` covers `ls` and `rg`.                                                                                                  |
| Q3  | Must Pia keep the full base schemas, and the skills list?                                  | Keep the short base schemas in Pia too: the meaning is the same, and a schema wrap for each conversation needs new registry work. Move Pia's skills list to search as well (1336 tokens), because Pia rarely runs skills itself. |
| Q4  | Is `PI_POCKET_LEAN_PROMPT=off` enough as the rollback, or must it be a setting in the app? | The switch is enough until phase 6. At phase 6, add a setting in the app only if the experiment shows that a model family needs the full prompt.                                                                                 |
| Q5  | Must the lean prompt be the default before the experiment gives results?                   | No. Merge phase 0 with the switch default "off" (full prompt), and turn it on per server for tests. Phase 6 makes it the default. On the branch it is "on" only to make measurement easy.                                        |
| Q6  | Is 1 model (`qwen3.8-27b-ud-iq3-xxs`) enough for the measurement?                          | For size, yes: Qwen and o200k counts differ by about 2 to 3%. For behavior, no: phase 5 must include 1 strong model (Claude or GPT) and 1 small local model.                                                                     |
| Q7  | Must prompt text live in Markdown files, and can the owner override them?                  | Yes for the files (phase 3), in `src/server/prompts/`. Owner overrides from `~/.pi-pocket/prompts/` are useful but are a later step: an override that breaks a rule (for example the guard text) needs a review path.            |
| Q8  | Must code mode replace `tool_search` and `tool_load` fully?                                | Yes, after phase 5b confirms it. Keep `tool_load` as a script-only tool for a rare native promotion at compaction.                                                                                                               |

## 13. Future work

1. **Phases 1 to 6** (section 9). The code mode plan is phase 4; the Markdown prompt files are phase 3.
2. **Trim old tool output** in long sessions: omit or replace old large tool results in batches (Pi Durable `omit` and `replace` edits), only when the output is large and many turns remain (section 3.2).
3. **Shorten the `artifacts` guide** (1222 tokens; cut 10).
4. **Compact skill descriptions:** the owner can set `disable-model-invocation` on skills that are never matched (12 marimo skills, about 1046 tokens in a full prompt).
5. **Measure the `claude-code` providers**, which add Claude Code's own system text and send tools through MCP (not measured here).

## 14. Out of scope

- The `claude-code` providers (Pia's model here) add Claude Code's own system text and send the tools through MCP. This report does not measure that part.
- The cache keeper (`src/server/cache-keeper.ts`) keeps a prompt warm for 5 minutes. It does not change these sizes.
