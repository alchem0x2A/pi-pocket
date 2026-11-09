# Review 2: lean start prompt after decisions A and B

Review of `d6c573b4..97aac04d` on `feat/lean-start-prompt`, and of `docs/proposals/prompt-cost.md` at `97aac04d`. The earlier review is `docs/proposals/prompt-cost-review.md` (`f441635d`). Tina's decisions in sections 15 and 16 of the plan replace some of its findings. This review does not change code.

## Verdict

**The branch can merge as opt-in.** I found no P1 finding. With `PI_POCKET_LEAN_PROMPT` unset or `off`, the rendered prompt and the tools are the same as on `d6c573b4` (section 4). 2 small code fixes (P2-1, P2-2) are recommended before the merge: each is about 5 lines. The plan has stale text that contradicts Tina's decisions (P2-4). Fix it before the plan is the handover for step 2.

Checks on `97aac04d`:

- `npm run check`: pass.
- `npx eslint .`: pass. `prettier --check` on the changed files: pass.
- `npm test`: 1038 tests, 1038 pass, 0 fail (1 full run).
- `test/lean-prompt.test.ts` alone: 8 of 8 pass.

## 1. Tina's 12 ideas

| #   | Idea                                                                                                                                                                     | Status                                        | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A normal session starts lean; the reference is the stock pi TUI (1057 / 1794 / 3139); the branch is 1581 (2056 real)                                                     | **Captured in code** (opt-in) and in the plan | Code: `src/server/extensions/prompt.ts:54-55,166,194-229`; `src/server/local-tools.ts:76-145,186-199`. Plan: section 4.1.3 (lines 161-180), section 4.1.4 (lines 182-192). The numbers are correct (section 3 below).                                                                                                                                                                                                                                                                      |
| 2   | 1 short line about the harness; the tool schemas carry the meaning; short descriptions are accepted                                                                      | **Captured in code**                          | `prompt.ts:57-58` (`LEAN_PREAMBLE`: "a multiplayer web app built on Pi Durable" is 1 clause; the other 6 sentences are behavior rules, 113 Qwen tokens). `local-tools.ts:84-145` (`LEAN_DECLARATIONS`). Plan: section 15, decision 3 (line 763).                                                                                                                                                                                                                                           |
| 3   | `AGENTS.md` and other project context load inlined, as in pi                                                                                                             | **Captured in code**                          | `prompt.ts:208` renders `project_context` in lean mode too. I compared the rendered text: it is identical to the full prompt. Plan: section 15, decision A (line 768). Stale plan text remains (P2-4).                                                                                                                                                                                                                                                                                     |
| 4   | Skills are not tools and are not listed; 1 pointer names the skill directories; the agent reads the whole `SKILL.md`; no per-project hiding; skill search is future work | **Captured in code**, with 2 defects          | `prompt.ts:65-90` (`leanPointers`), `prompt.ts:210-222` (no `skills` section in lean), `app.ts:774` (`skillPlaces`). `tool_search` returns no skills (`local-tools.ts` `discoveryTool`). Plan: section 15, decision B (line 769); section 13, item 6 (line 740). Defects: P2-2 (empty pointer) and P3-3 (`disable-model-invocation`).                                                                                                                                                      |
| 5   | Opt-in (`PI_POCKET_LEAN_PROMPT=on`); the full prompt stays the default; every switch combination keeps skills and project rules reachable                                | **Captured in code**                          | `prompt.ts:54-55` (lean only with `=on` and discovery not `off`); `local-tools.ts:76`; `local-tools.ts:598` (discovery `off` bypasses the view). Test: `test/lean-prompt.test.ts:240-267`. Gap: the suite never runs with the switch unset (P2-5).                                                                                                                                                                                                                                         |
| 6   | The rule "notes are data and can be out of date" is visible before a note is read                                                                                        | **Captured in code**                          | `prompt.ts:85` (`on_demand`), and the `note_search` description at `local-tools.ts:124-131`. Test: `test/lean-prompt.test.ts:181-187`. P3-4: the line renders also when the memory module is off.                                                                                                                                                                                                                                                                                          |
| 7   | Exactly 1 long-running Pia conversation, identified by its stored identity, never by a tool                                                                              | **Captured in code**                          | `app.ts:838-842` (`this.pia.ownerOf(conversationId) !== undefined`); `local-tools.ts:184` (`PiaIdentity`), `:188`, `:543`, `:573-581`; `prompt.ts:157-166` (`host.pia.ownerOf`). `ownerOf` reads `assistantOwner` of the session meta (`src/server/pip.ts:289-291`). The `session_start` check is gone. Side effect: P3-1.                                                                                                                                                                 |
| 8   | Pia is a normal lean session plus a short role section (`{owner_name}`, `{helper_name}`) and the session tools; Pia is not manager-only and does quick work itself       | **Partly captured, in the plan only**         | Plan: section 16, step 4 (line 780); section 15, decision 7 (line 767); section 12, Q3 (line 726). Contradictions: section 2 (line 45) still says "Pia keeps a larger prompt … with phase 2 cuts"; section 4.2 "Fate (target)" still lists phase 2 cuts. The plan does not say that Pia does quick work itself and is not manager-only. The current `piaPreamble` (`src/server/extensions/pip.ts:31-34`) puts oversight and decluttering before work. Not implemented (expected: roadmap). |
| 9   | Automatic reports from all sessions to Pia are removed                                                                                                                   | **Captured in the plan**                      | Section 15, decision 5 (line 765); section 13, item 7 (line 741); section 16, step 5 (line 781). The role template in `prompt-cost-review.md:164` still says "Other sessions report their work to you": step 4 must not copy it.                                                                                                                                                                                                                                                           |
| 10  | Roadmap: a person tells a session to report back to Pia                                                                                                                  | **Captured in the plan**                      | Section 15, decision 6 (line 766); section 13, item 7 (line 741); section 16, step 5 (line 781).                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Roadmap: Pia starts a session with a fitting start set of tools and skills; the set is a start, not a limit                                                              | **Captured in the plan**                      | Section 13, item 8 (lines 742-747); placed after section 16 (line 789). P3: item 8.3 still says "because the index is filtered"; there is no index after decision B.                                                                                                                                                                                                                                                                                                                       |
| 12  | Prompt text moves from TypeScript strings to Markdown files                                                                                                              | **Captured in the plan**                      | Section 2 (line 47); section 9, phase 3 (line 626); section 16, step 3 (line 779). Not implemented (expected).                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Findings

No P1 finding.

### P2-1. A hot reload before the restart sends a warning on each prompt load

`prompt.ts:141-145` calls `host.skillPlaces(cwd)`. `host.skillPlaces` is new in `app.ts:774` and `host.ts:344`. `src/server/extensions/*.ts` reload into the running server at once, but `app.ts` needs a restart. After the merge into the main checkout, the old host has no `skillPlaces`. Each resource load then sends this owner notice:

```
warning: Could not load skill places for <cwd>: TypeError: host.skillPlaces is not a function
```

I reproduced it: the `97aac04d` `prompt.ts` on a `d6c573b4` host. The rendered prompt was the same as on `d6c573b4`, so only the notice is wrong. Resources expire after 30 s (`STALE_MS`), so the notice comes again for each folder and each later request until the restart.

**Fix:** guard the call, as `src/server/extensions/pip.ts:791` does for `host.pia.inbox`: `typeof host.skillPlaces === "function" ? host.skillPlaces(cwd) : []`. Then P2-2 covers the empty list.

### P2-2. With no skill directories, the pointer says "in ."

`leanPointers` (`prompt.ts:65-90`) always writes the skill line. When `places` is empty, the line is:

```
- Skills: each skill is a SKILL.md file in . Look there when a task can need a skill. …
```

I reproduced it with no `~/.agents/skills`, no `<agentDir>/skills`, and no settings paths. It happens also after P2-1's fallback, and when `skillPlaces` throws. **Fix:** leave the line out when `dirs` is empty. Add a test.

### P2-3. The identity test does not cover the guide wraps or a real lean Pia chat

`test/lean-prompt.test.ts:269-327` uses a fake registry with no tools and no extensions. It tests `task_focus`, `available_tools`, and `tool_discovery`. It does not test the wrap at `local-tools.ts:538-551` (`leanOnly && isPiaChat(...)`). That wrap keeps `ink_board`, `inbox-notes`, and `memory` in a Pia chat from the start in lean mode. Test 6 (`:221-238`) opens a real Pia chat but checks only `guidelines`, `skills`, and `tool_discovery`. The memory, ink board, and inbox note modules are not on in that app.

**Add:** a real Pia chat with lean on and these 3 modules on. Check that `memory`, `ink_board`, and `inbox-notes` render in Pia and not in a normal session.

### P2-4. The plan contradicts Tina's decisions in several places

The plan says it is "the only handover" (line 3). These parts are stale:

- Section 2, line 45: "Pia: keeps a larger prompt … with phase 2 cuts." Section 16, step 4 replaces this (idea 8).
- Section 4.1.2 (lines 194-224): the "After" column shows `project_context` 0, `skills` "tool_search also finds skills", and `on_demand` 79 with `AGENTS.md` paths. Mark it as phase 0 history, or replace it with the parts of section 4.1.3.
- Section 4.1.3, line 163: "Same setup and method." The 1581 / 2056 fixture (`/tmp/pcost/lean3-request.json`) has no `ink_*` tools, so `ink-board` was off. Section 4.1.1 says it was on. With `ink-board` on, the branch measures 1605 compact and 2080 real (section 3). Say which modules were on.
- Section 5.3, line 495: "Start cost (real, local Qwen): 1272". After decisions A and B it is 2056.
- Section 6, the "Project context" row (line 507): "`on_demand` gives each path with 'read before you change files'". Decision A removed this.
- Section 9, phase 0 (line 594): it lists `isPia`, `matchSkills`, `discoveryTool(skills)`, and `localToolRegistry(…, (cwd) => this.skills(cwd))`. None of these is in the code now.
- Section 12, Q1 (line 724): "Inline when the files together are under 300 tokens; else the pointer." Decision A answers Q1: always inline. Mark it as answered.
- Section 13, item 8.3 (line 745): "because the index is filtered". There is no index after decision B.
- Section 8.1 has no line for the `skillPlaces` hot-reload problem (P2-1), and section 8.3 does not say that the restart is necessary for the notices to stop.

### P2-5. No test runs with `PI_POCKET_LEAN_PROMPT` unset

`test/helpers.ts:24` sets the switch to `off`. The 4-combination test (`test/lean-prompt.test.ts:240-267`) uses `on` and `off`, never unset. The default is "unset", so the suite does not test the real default. Section 4 below shows that the default is correct today. **Add:** 1 test that deletes the variable and checks the full prompt. A snapshot test against the full prompt text is better (it also protects step 3, the Markdown move).

### P3 findings

- **P3-1. A Pia subagent now gets `task_focus` in the default mode.** A subagent of the Pia chat copies Pia's stored agent (Pi Durable `createAgent`, `pi-durable/dist/harness/agent.js:145-153`), so it selects `pocket-pip` and has `session_start`. On `d6c573b4`, `task_focus` was hidden for it (the tool check). On the branch, its stored identity is not Pia, so `task_focus` renders. This follows decision 4 and is probably correct. It is the only default-mode change that I found. Record it in the plan. In lean mode, the subagent also gets the lean prompt with the session tools.
- **P3-2. Stale comments.** `local-tools.ts:81-82` says "Execution and validation keep the original schema". Pi Durable validates against the offered (wrapped) declaration (`pi-durable/dist/harness/tool.js:59-60,176-179`); `local-tools.ts:148-150` says this correctly. `local-tools.ts:189-190` says "the prompt's skill index lists them"; decision B removed the index.
- **P3-3. The pointer exposes skills with `disable-model-invocation: true`.** `formatSkillsForPrompt` leaves these skills out of the full prompt (`pi-coding-agent/dist/core/skills.js:272-279`). The directory pointer lets the agent find and use them. None of the 14 current skills sets the flag. Decide this before step 9 (the default decision).
- **P3-4. The note rule renders without the note tools.** `prompt.ts:85` names `note_search` and `note_load` also when the memory module is off. Render the line only when a note tool is offered, or accept the 41 extra tokens.
- **P3-5. The pointer can name paths that are not skill directories.** `skillPlaces` (`src/server/skills.ts:184`) passes `settingsPaths` without `existsSync` and without resolution. A settings entry can be a missing path, a relative path (the loader resolves it against `cwd`), or a single `.md` file. The pointer says "a SKILL.md file in" each of them. The loader also skips `node_modules`, dot folders, and ignored paths, and keeps the first skill of each name. An agent that lists the folders by hand does not apply these rules.
- **P3-6. `~` uses the process home, not the app home.** `leanPointers` uses `os.homedir()` (`prompt.ts:68`). The skill sources use `this.#home` (`app.ts:2953`). They are the same on the real server. In tests they differ, so the test sees absolute paths.
- **P3-7. `formatSkillsForPrompt` moved out of the `try` block.** On `d6c573b4` it ran inside `load()`'s `try` (a failure became a notice). Now it runs in the `skills` section render (`prompt.ts:210-220`), so a failure fails the section. The risk is low: it formats loaded skills only.
- **P3-8. Policy and sections read the switch at different times.** `inBase` and the tool wraps are built once per registry snapshot (`local-tools.ts:505-519`). The sections read `PI_POCKET_LEAN_PROMPT` at each render. A switch change without a snapshot change (only in tests) mixes the 2 modes. Tests open a new app for each switch value, so this is not visible today.

### Missing tests (summary)

1. The default with the switch unset; a snapshot of the full prompt (P2-5).
2. A real lean Pia chat with `memory`, `ink-board`, and `inbox-notes` on (P2-3).
3. An empty skill place list (P2-2); a hot reload on an old host (P2-1).
4. The pointer with a trusted project skill folder, a distrusted one, a duplicate place, a `~` path, a missing settings path, and a relative settings path.
5. A Pia subagent: its identity and its prompt in both modes (P3-1).
6. A lean `edit` call with the legacy top-level `oldText` and `newText` (`prepareArguments` runs before validation; I read the code, but no test covers it).

## 3. Token measurement claims

| Claim                                  | Check                                                                                                        | Result                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi bare 1057 (478 prompt + 579 tools)  | `/tmp/pcost/pitui.json` with the Qwen tokenizer (`/tmp/pcost/tok/qwen.json`), no chat template               | **Reproduced:** 478 + 579 = 1057                                                                                                                        |
| pi with `AGENTS.md` 1794               | same                                                                                                         | **Reproduced:** 1215 + 579 = 1794                                                                                                                       |
| pi with `AGENTS.md` and 14 skills 3139 | same                                                                                                         | **Reproduced:** 2560 + 579 = 3139; 14 skills; the context file is `/home/ttian7/Dev/pi-pocket/AGENTS.md` (the same text as the worktree's)              |
| Branch 1581 compact                    | `/tmp/pcost/scripts/parts.py` on `/tmp/pcost/lean3-request.json`                                             | **Reproduced:** 1581. Parts: `preamble` 113, `project_context` 729, `on_demand` 160, `environment` 26, `available_tools` 56, `task_focus` 29, tools 468 |
| Branch 2056 real                       | `/tmp/pcost/scripts/payload.ts` on the same fixture, local router, `qwen3.8-27b-ud-iq3-xxs`, `max_tokens: 1` | **Reproduced:** `usage.input` 2056, `cacheRead` 0                                                                                                       |
| Step 1: 1685 compact, 2160 real        | `parts.py` on `lean2-request.json`                                                                           | 1685 reproduced; 2160 not sent again                                                                                                                    |
| The fixture is the current code        | I captured the first request again from `97aac04d` with `dump-lean.ts`                                       | **Same:** 1581 compact and 2056 real with the modules of the fixture                                                                                    |

Notes:

- The fixture has no `ink_*` tools, so `ink-board` was off. With `ink-board` on, `available_tools` grows from 56 to 77 tokens: **1605 compact, 2080 real** (measured now). The plan says "same setup" as section 4.1.1, which had `ink-board` on (P2-4).
- The pi TUI numbers and 1581 use the same method: Qwen tokenizer, compact tool JSON, no chat template. The comparison is fair for size. The branch offers 8 tools; pi offers 4. The branch includes `AGENTS.md` (729) and no skill list.
- `on_demand` in the fixture has a temporary data path (`/tmp/pi-pocket-test-…/data`). The real `~/.pi-pocket` path changes the count by a few tokens.
- `test/lean-prompt.test.ts:163` is a character bound (< 5500) and says so. It is not a token test. This is correct.
- The 1500 goal is not met (2056 real). The plan says this (section 4.1.3, section 11 risk 2).

## 4. The default (lean off) against `d6c573b4`

Method: a script (`/tmp/rv2/scripts/dump.ts`, not committed) opens a throwaway app from each checkout (`test/helpers.ts`), with `ink-board`, `inbox-notes`, `memory`, `browser`, `schedules`, `codemode`, and `restart` on, 1 `AGENTS.md`, and 1 skill. It folds the first request into sections and tool declarations, and replaces the temporary paths. `d6c573b4` ran from a temporary worktree (`/tmp/rv2/base`).

| Conversation | `PI_POCKET_TOOL_DISCOVERY` | `PI_POCKET_LEAN_PROMPT` | Same as `d6c573b4`   |
| ------------ | -------------------------- | ----------------------- | -------------------- |
| Normal       | on                         | unset                   | Yes (byte-identical) |
| Normal       | on                         | `off`                   | Yes                  |
| Normal       | off                        | unset                   | Yes                  |
| Normal       | off                        | `off`                   | Yes                  |
| Pia          | on                         | unset                   | Yes                  |
| Pia          | on                         | `off`                   | Yes                  |
| Pia          | off                        | unset                   | Yes                  |
| Pia          | off                        | `off`                   | Yes                  |

With lean on, the Pia sections are also identical to `d6c573b4`. Only the tools change: `edit` is added and `ls` is removed, and the base schemas are short (plan section 8.3).

Code reading agrees. In the default, `inBase` is `BASE`, there are no lean wraps, and `LEAN_LAZY_GUIDES` is not used. `available_tools` and `tool_discovery` take the old path. The guide wrap is the same for `LAZY_GUIDES`. Exceptions:

- `task_focus` for a conversation that has `session_start` but is not the stored Pia chat, for example a Pia subagent (P3-1).
- The owner notices between the merge and the restart (P2-1).

## 5. Merge verdict

**Ready to merge as opt-in**, under these conditions:

1. Recommended before the merge: fix P2-1 (guard `host.skillPlaces`) and P2-2 (no empty pointer line), each with a test.
2. Before step 2 (the baseline experiment): fix the plan (P2-4), add the tests of P2-3 and P2-5, and record the module set of each measurement.
3. After the merge: restart the server. Until the restart, the owner sees the P2-1 notices if P2-1 is not fixed. With the default (lean off), the restart changes nothing visible except P3-1.
4. Do not turn the lean prompt on by default before step 9. Step 2 must test the skill directory pointer with real models: the agent must find a skill without a list.

## 6. Status of the findings (fixes on this branch)

Tina asked for all findings to be fixed, with 1 rule for every change: a code change must never show the user a warning.

| Finding        | Status                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1           | Fixed. `prompt.ts` checks that `host.skillPlaces` is a function. Without it, or when it fails, the lean prompt keeps the full skill list: no notice. Checked on a `d6c573b4` host: 0 notices. |
| P2-2           | Fixed. The skill line is left out when no skill place exists.                                                                                                                                 |
| P2-3           | Fixed. A test opens a lean Pia chat with `ink-board` on and checks `memory`, `ink_board`, and `inbox-notes`.                                                                                  |
| P2-4           | Fixed in `docs/proposals/prompt-cost.md`, with decision 10 (Pia's role, idea 8).                                                                                                              |
| P2-5           | Fixed. The 4-combination test also checks the switch unset against `off`.                                                                                                                     |
| P3-1           | Recorded in the plan (sections 8.1 and 8.3). The code stays: it follows decision 4.                                                                                                           |
| P3-2           | Fixed (2 comments).                                                                                                                                                                           |
| P3-3           | Fixed. A skill with `disable-model-invocation: true` adds 1 sentence to the skill line.                                                                                                       |
| P3-4           | Fixed. The note rule renders only when a note tool is offered.                                                                                                                                |
| P3-5           | Partly fixed. Missing paths are left out, relative paths resolve against the session folder, and `.md` files are named as skill files. Left: the loader's ignore rules (risk 10 in the plan). |
| P3-6           | Fixed. `~` uses `HOME`, then `os.homedir()`.                                                                                                                                                  |
| P3-7           | Fixed. `formatSkillsForPrompt` runs inside `load()`'s `try` again.                                                                                                                            |
| P3-8           | Left. Recorded as risk 11 in the plan.                                                                                                                                                        |
| Missing test 6 | Added: an old `edit` call with top-level `oldText` and `newText`.                                                                                                                             |
