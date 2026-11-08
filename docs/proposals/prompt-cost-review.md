# Review: lean prompt and the owner's helper

Review of `d6c573b4..5bbbc0de` and the plan at `fae119fe`. This review recommends changes. It does not change the implementation.

## Decision

**Do not merge phase 0 as the default.** The measured first request meets Tina's size goal for the tested configuration. The implementation does not yet preserve instruction discovery and safety behavior reliably. It also has an incompatible rollback combination.

Use the same lean session design for the owner's helper. Add a short role section and the existing session tools. Do not keep a separate, large set of helper rules. Keep protections that are not enforced by code, and give them to all sessions where they apply.

I ran `npm run check`, `npm run lint`, and `npm test` on this branch. All passed: 1035 tests, 0 failures. I also ran `test/lean-prompt.test.ts` separately: 5 tests passed. These checks do not establish model behavior. Most existing tests select the full prompt and turn discovery off in `test/helpers.ts`.

## 1. Findings on the code diff

### P1. The discovery rollback can hide every skill

`src/server/extensions/prompt.ts:51-63,137,176-193` selects the lean prompt unless `PI_POCKET_LEAN_PROMPT=off`. It then removes the skill list and tells the agent to use discovery indirectly.

`src/server/local-tools.ts:644-655` returns the original registry when `PI_POCKET_TOOL_DISCOVERY=off`. That bypasses the local `tool_search` and `tool_load` tools. With only this existing rollback switch off, the lean prompt still hides skills and does not provide the promised search route.

**Required:** Couple the switches, or make each configuration provide a complete discovery path. Test all 4 combinations of the switches. Test the tools and rendered prompt, not only the environment values. The current shared test setup exercises only `off/off`; the lean test exercises `on/on`.

### P1. Project and global instructions no longer apply before many actions

`src/server/extensions/prompt.ts:57-63` labels every discovered context file as project instructions and says to read it only before changing files. The loader also finds global instructions and other supported context file names. Those instructions can govern reviews, commands, secrets, communication, or reading data. Those activities need no file change.

The previous `project_context` put the contents in the prompt. A pointer cannot guarantee that a model will read the file. This is a behavior and safety regression, not only a token trade-off. It also affects `CLAUDE.md` and `AGENTS.override.md` when the loader selects them.

**Required:** Preserve the scope of every global and project instruction. Make the agent obtain applicable instructions before any relevant action, including reviews and commands. A mandatory preflight or enforced policy can help. Test with a global instruction, a long project instruction, a non-writing task, a folder change, and a changed instruction file. Do not claim an arbitrary 300-token threshold solves this problem.

### P1. Skill search is not a reliable replacement for the skill list

`src/server/local-tools.ts:365-389,441-484` matches any query word as a substring. The comment says every word must match, but the code requires only 1 hit. Common words can rank unrelated skills. One-character terms are discarded. A semantic match with no shared word returns nothing.

For example, `search the web` also matched the unrelated `marimo-notebook` and `retro-marimo-pair` fixtures in a direct call to `matchSkills`. A query of `x` returned no skills. The lean prompt does not tell the agent when it must search for a skill. It only says that `tool_search` can find skills, and that sentence disappears when there are no deferred tool names at `local-tools.ts:186-195`.

**Required:** Add an explicit, compact discovery rule. Test realistic task descriptions, common words, exact names with case differences, 1-character names, synonyms, ranking limits, project trust, unreadable sources, and zero deferred tools. Establish a behavior gate with real models. Keep a safe fallback when search fails.

### P1. The memory trust rule is hidden before notes are read

`src/server/local-tools.ts:99-112,219,583-594` hides the `memory` section until the separate `memory` tool is loaded. `note_search` and `note_load` remain available. The shortened descriptions do not say that note text is data, that it can contain instructions, or that a note must be checked before use. They also omit the rule to search before a later action that a note can cover.

The note tags in `src/server/extensions/memory.ts` are useful labels. They do not make a model reject instructions in note text. Keep a compact trust and freshness rule available before a note can be used. Test hostile note content and later actions after the first task search.

### P2. The shortened descriptions lose operational facts

`src/server/local-tools.ts:81-112` says that `read` and `bash` output is cut at 2000 lines. Both also have a 50 KB limit. `bash` keeps the tail and can save full output to a temporary file. The short `read` description omits 1-based offsets and the instruction to continue until a needed file is complete. The short `edit` description omits that every edit matches the original file.

Tool results can supply some details, but that does not make the declarations equivalent. Add the facts that prevent incomplete reads and wrong edits. Test a 50 KB single-line file, line offsets, truncated command output, and multiple edits. The existing test covers only one small write, edit, and read.

### P2. Message routing and STE behavior were weakened

`src/server/extensions/prompt.ts:53-55` keeps a short STE request only for messages that start with the markers. The former rule also covered `[from: Name]` and `[scheduled]` prefixes, messages sent back to agents, and a later return to normal answers. It explained enough of ASD-STE100 for a model that does not know the standard.

Test each prefix and the return to normal replies. Test instructions sent to agents as well as answers. Move a compact common rule to the common prompt or a reliable message-specific instruction. Do not assume every sender supplies it.

### P2. Pia detection uses the presence of a tool as identity

`src/server/local-tools.ts:177-183,591-594,622-624` identifies the helper by the name `session_start`. The prompt module uses `host.pia.ownerOf` instead. An absent, excluded, or changed tool can therefore give a helper a mixture of full and lean sections. A different registration with that name can have the opposite effect.

Use the same explicit conversation identity for both policies. Test disabled and excluded tools, extension reload, old servers, and ordinary sessions. Do not use a tool name as an authorization boundary.

### P2. The token test is not a token test

`test/lean-prompt.test.ts:101-135` asserts fewer than 5000 characters. Four characters per token is not a reliable upper bound for paths, JSON, other languages, or provider wire formats. The test also excludes provider templates and uses a controlled fixture.

Keep a fast character check if useful. Add a reproducible tokenizer and wire-payload test, and a separate real-provider measurement. State the enabled modules, user message, paths, instructions, and tokenizer. Test a long path, multiple context files, and a large extension catalog. An unrestricted owner instruction or extension section makes a universal 1500-token ceiling impossible.

### Other missing tests

- Run relevant existing prompt, memory, skills, plan-mode, and discovery tests with the lean configuration enabled. Do not rely on the full-prompt default in `test/helpers.ts`.
- Check short schema calls through the real harness, including invalid, legacy, and repaired arguments. Verify guards and hooks receive the same arguments.
- Check skill discovery after a trust change and a working-folder change. Check failures instead of silently treating an unreadable skill source as no skills.
- Check `AGENTS.md` and skills across restart, reset, compaction, fork, and extension reload. Test owner instructions and unknown extensions.
- Check the `ink_board`, `inbox-notes`, and `memory` guide triggers. Check that a task can discover the guide before it needs the guide's rules.
- Check a normal session, the helper, and subagents with and without optional tools. Check `[via …]`, scheduled, webhook, watch, and report messages.

## 2. Measurements

The recorded normal request changes from 5457 to 1272 input tokens: 4185 fewer, or about 76.7%. The recorded helper request changes from 9731 to 9380: 351 fewer, or about 3.6%. Those are plausible real measurements for the described local Qwen request. I did not send a new request to the inference router.

The saved fixtures in `/tmp/pcost/` and the Qwen tokenizer reproduce 798 compact tokens for the lean normal request and 8336 for the lean helper request. They also reproduce 5531 for **all** helper prompt sections. This is not the cost of the helper-only sections. In the measured first request, the helper-only sections total 2126: `pia` 650, `pia_rules` 1009, `pia_github` 307, `pia_shared` 94, and `pia_environment` 66. `pia_inbox` is absent in that fixture.

The statement that only the base schemas became shorter is incomplete. `edit` also replaced `ls` in the first offered tool set. Both helper requests have 21 tools, but they do not have the same 21 tools. The helper sections stayed unchanged.

The 1272 result includes the short user message `hi`, a provider payload, and the local model's chat template. It is evidence for that configuration, not a bound for all sessions. Paths, selected modules, owner instructions, other providers, and user messages change the count. The compact-token and wire-token sums use different serialization. Their difference is not solely a chat-template cost unless the same full payload is compared.

The report says a repeated request was a cache read. The saved payload script reports usage, but it does not by itself establish which prefix was read from cache. Preserve the raw provider usage fields, payload hashes, timestamps, and router/model versions before making cache savings claims. A section edit or a `pi.system` entry is not itself proof of a billed cache miss. Measure actual cache-read and cache-write usage per provider.

The temporary scripts and local fixtures help this review, but they are not durable or sufficient to reproduce the result on another machine. Add a sanitized fixture and script to the repository. Do not commit private prompts, session text, credentials, or live database contents. Qwen and `o200k_base` counts do not establish Claude wire counts or behavior.

The claimed 5600-token re-send is an estimate based on history and prompt size. It is not a measured cost for each load. The current lean prompt is much smaller than the earlier full prompt. Measure the actual prefix and provider cache usage for each case. The prior report's rare-helper-tool cut also says about 1260 tokens in one place, but the listed current compact schemas sum to 1542 tokens before catalog costs.

## 3. Check of the helper-only parts

The token values below are Qwen3.6 compact counts from the plan's first-request fixture. Section values include rendered wrappers. Tool values are compact declarations, not provider wire costs. Values depend on names, paths, enabled modules, and owner content. **5531 is the total of all helper sections**, including sections shared with ordinary sessions.

| Part | Tokens | Purpose | Verdict |
| --- | ---: | --- | --- |
| `pia` | 650 | Identity, priorities, session work, workspace, model selection, and response style. | **Shorten.** Keep a small role section with 2 name placeholders. Remove the small-work-only hierarchy. Move tool details to tools or results. |
| `pia_inbox` | 0 in the first fixture; 59 in the stored example; variable | Tells the helper about pending and tagged notes. | **Make on demand.** Preserve reliable notification and tag routing. Do not put a changing count in a fixed prefix. |
| `pia_rules` | 1009 | Data boundaries, approvals, agent messages, reports, outside events, stop/archive, and merges. | **Shorten.** Move general safety rules into the common design. Keep protections without code enforcement. Move task-specific instructions to messages or tool results. |
| `pia_github` | 307 | Repository work, worktrees, watches, and PR follow-up. | **Move to tool descriptions** or make on demand. Keep owner authorization and untrusted-event rules available before action. |
| `pia_shared` | 94 in the fixture; variable | Injects the owner's shared `AGENTS.md`. | **Keep the owner's instructions.** Use the same reliable instruction mechanism as a normal session, whatever the helper's folder. Do not silently discard the content. |
| `pia_environment` | 66 | Date, zone, workspace, and default folder. | **Shorten.** Keep the ordinary environment and workspace. Obtain date, zone, and default folder on demand. |
| `sessions` | 133 | Lists visible sessions. | **Keep.** |
| `session_read` | 95 | Reads session state and recent output. | **Keep.** |
| `session_start` | 351 | Starts a session and can send its first task. | **Keep; shorten** only after argument and behavior tests. |
| `session_send` | 143 | Sends a task or message. | **Keep.** |
| `session_follow` | 72 | Reports a followed run. | **Keep.** |
| `session_model` | 156 | Changes a session's model. | **Keep.** Put choice guidance in the tool result. |
| `session_stop` | 54 | Stops a run and clears its queue. | **Keep.** Retain the owner-request rule. |
| `session_archive` | 73 | Archives or restores a session. | **Keep.** Retain the owner-request rule. |
| `session_schedule` | 254 | Schedules messages to a session. | **Keep.** Preserve timing and attribution details. |
| `approvals` | 91 | Lists or denies pending calls. | **Keep.** It must not gain an allow action. |
| `inbox` | 205 | Lists, archives, restores, or posts inbox notes. | **Keep.** Keep note text as data. |
| `repo_watch` | 512 | Configures repository event watches. | **Keep; shorten** only with schema and safety tests. |
| `session_watch_pr` | 197 | Manages a session's PR watch. | **Keep.** |
| Workspace `<dataDir>/pia` | No separate fixed token cost; its path and file are counted above | Provides persistent shared files and standing instructions. | **Keep.** This is a default folder, not a sandbox. Keep its file across Start fresh. |

The 13 helper tools total 2336 compact tokens in this fixture. The 5 core tools total 794. The other 8 total 1542. The helper extension registers the tools when its host capabilities exist. `NEVER_DEFERRED` keeps `pocket-pip` tools offered from the start, subject to selection and enabled-tool filters.

The helper also retains full common sections on the branch. These are not intrinsically helper-only:

| Common part retained for the helper | Tokens | Purpose | Verdict |
| --- | ---: | --- | --- |
| `guidelines` | 389 | General interaction, images, destructive actions, and agent messages. | **Shorten** for every session. Preserve the safety and message rules. |
| `pocket_docs` | 386 | Documentation paths and data-handling rules. | **Make on demand** for every session, with a working pointer. |
| `project_context` | 0 in this fixture; variable | Other applicable global and folder instructions. | **Keep the instructions.** Use the same reliable mechanism as ordinary sessions. |
| `skills` | 1336 | Lists 14 skill names, descriptions, and paths. | **Make on demand** for every session only after discovery is reliable. |
| `memory` | 128 | Describes note scope, trust, and saving rules. | **Shorten.** Keep note trust and search rules available before notes are used. |
| `inbox-notes` | 101 | Explains tagged notes to the helper. | **Make on demand.** The helper's own `inbox` tool is a different tool. |
| `ink_board` | 506 | Explains board discovery, markup, and resolution. | **Make on demand**, with a clear discovery trigger and workflow tests. |
| `available_tools` | 430 | Lists tool names and summaries. | **Shorten** under the common discovery design. |
| `tool_discovery` | 101 | Explains search and loading. | **Move to tool descriptions** when those descriptions are sufficient. |
| `environment` | 28 | Gives working folder and platform. | **Keep** in the common prompt. |

Code check: `pia_github` depends on host capability methods at `src/server/extensions/pip.ts:271-274,820`, not on a fresh `gh` sign-in check. The plan's section 3.1.1 states the latter. Repository operations still perform their own checks.

## 4. Protections and enforcement

A prompt rule is not a security boundary. Code checks and clear data labels complement it. They do not prove that a model will ignore an instruction inside data.

| Protection | What the code enforces now | Verdict |
| --- | --- | --- |
| Session output and outside text are data, not instructions | `src/server/pip.ts:130-132,873-966,1561-1585` fences session text. `src/server/fence.ts` defangs closing tags and quotes other text. Watch and webhook code fences payloads too. | **Keep a short common trust rule.** Fences label data; they do not enforce model behavior. Keep the distinction between owner-authored watch instructions and outside payloads. |
| The helper can deny, but cannot allow an approval | `src/server/extensions/pip.ts:553-586` exposes only `list` and `deny`. `src/server/pip.ts:1353-1356` passes `false` to `answerApproval`. | **Keep in the approval tool description and test it.** This holds for the helper approval tool, not a general proof about every possible shell, credential, or app route. `src/server/app.ts:2618-2642` separately checks steering, visibility, and human approval policy. |
| Stop or archive only when asked or covered by standing instructions | `src/server/pip.ts:1303-1325` checks a recent session look before stop and before a new archive. It does not establish owner intent. | **Keep the rule before these actions.** A 15-minute look is not permission. Test unsolicited stop and archive cases. |
| People merge PRs; no default-branch push or branch deletion without an exact request | The helper's session tools do not enforce this rule. The helper has normal tools, including shell access. | **Keep a short common rule**, or add a real enforcement mechanism. A requested exception must remain explicit. |
| Do not start unrelated work or obey outside instructions | Access, attribution, fences, and some rate limits exist. They do not determine the owner's intent. | **Keep a common task and trust rule.** Test hostile session text, titles, logs, notes, and GitHub events. |
| Read current session state before acting | `src/server/pip.ts:589-605` requires a recent look for several actions. A start, a report, or `session_read` can establish one. | **Move detail to tool descriptions and errors.** Preserve the code checks and their 15-minute window. Test the exceptions. |
| Repository access and stranger events | `src/server/pip.ts:1112-1122` checks push access for checkout. `src/server/extensions/pip.ts:679-683` and `pip.ts:1264-1274` reject `anyone: true` from the agent. | **Keep code enforcement.** Explain refusals in tool results. Do not claim that these checks restrict arbitrary shell commands. |
| Model choice guidance | `src/server/pip.ts` checks the owner's marked guidance and one-use code before a start or model change. | **Keep code enforcement.** Put the current guidance and next step in the tool result. Test a changed note, expiry, restart, and worktree default. |
| Memory approval | `src/server/extensions/memory.ts` and `src/server/memory.ts` make agent note proposals wait for owner approval. | **Keep code enforcement and a short note-data rule.** Approval does not make note text a higher-priority instruction. |

The guard is optional, and plan mode is not a security boundary. Keep the instruction to say what a destructive step will do and not work around a block. Test guard-on and guard-off behavior. Preserve owner, visibility, steering, attribution, spend, and audit checks in every proposed routing change.

## 5. Target design and budget

The helper is a normal lean session. It can do ordinary work directly. It also has the 13 current `pocket-pip` tools and a short role section. Do not impose a rule that it only manages sessions or delegates all substantial work.

A proposed role template is:

> You are `{helper_name}`, `{owner_name}`'s helper. Other sessions report their work to you. Help `{owner_name}` directly or use the session tools when the task needs them.

`{owner_name}` currently resolves to `Tina`. `{helper_name}` currently resolves to `Pia`. These are values, not hardcoded role text. `src/server/extensions/pip.ts:781-785` already calls `host.pia.ownerName(input.conversationId)` and `host.pia.name()`. `src/server/pip.ts:220-221,289-300` resolves the helper display name from `config.assistantName` and the owner name from the conversation's owner. The fallback helper name is `PIA_DEFAULT_NAME` in `src/server/pia.ts`; a missing owner record falls back to `the owner`.

Keep both placeholders in the Markdown role template and count their rendered values in the budget. Test changed names, missing owner records, long names, escaping, and the workspace under a non-default data directory. `PIA_NAME` in `src/server/pip.ts:69` is also a protocol marker. Do not silently rename `[via Pia]`, stored identifiers, or report markers when the display name changes.

Keep the existing private conversation, owner checks, persistent workspace, reset behavior, and session tool permissions. Apply the same instruction, skill, documentation, memory, and guide mechanism to the helper and ordinary sessions. The owner's shared `AGENTS.md` applies even when the helper changes folder. It is owner content, not a new hardcoded role rule.

### Estimated first-request budget

The target below keeps **all 13 helper tools offered from the start**. It is not the original phase 2 proposal to defer 8 tools.

| Component | Estimated Qwen tokens |
| --- | ---: |
| Measured lean normal first request, including `hi` and the local template | 1272 |
| All 13 helper tool declarations, measured in the fixture's wire form | about 2889 |
| Role section, including rendered `{owner_name}` and `{helper_name}` | at most 100, target |
| Workspace pointer and catalog differences | about 50, allowance |
| **Estimated total** | **about 4311; target at most 4500** |

This is an estimate, not a measured target payload. Some catalog names can disappear when tools are offered, so additions are not strictly additive. Owner instructions, extra extensions, long names, and nontrivial user messages can increase the count. Measure the final rendered payload and actual provider usage. Do not claim a universal 4500-token cap.

If Tina later chooses to defer the 8 less frequent tools, the 5 core tools cost 794 compact tokens, or about 984 in this fixture's wire form. The same rough calculation gives about 2406 tokens. That is a separate design choice and needs discovery and behavior tests. It is not required for the target above.

### Reports from other sessions

The proposed role says that other sessions report to the helper. The current code does not automatically report every session. `session_start` and `session_send` normally create a follow; `session_follow` can follow another run. These paths can also omit a report. `src/server/pip.ts:1417-1456,1561-1701` implements follows and their reports.

Treat automatic reporting as a separate product change, not as a prompt rewrite. Define which sessions and run outcomes report, who can see them, and what happens when the helper is off. Preserve fencing, attribution, spend limits, idempotency, restart recovery, and rate limits. Avoid duplicate reports from existing follows, feedback loops, and disclosure of a session the owner cannot see. Test all of these before the role claims automatic coverage.

## 6. Answers to section 12

| Question | Answer |
| --- | --- |
| Q1: Inline small `AGENTS.md` files? | **No fixed 300-token rule.** Size does not determine authority or risk. Preserve all applicable global and project instructions before relevant actions. Measure the cost and behavior of a reliable preflight. If the 1500-token goal conflicts with arbitrary owner instructions, state that conflict instead of silently dropping instructions. |
| Q2: Offer `edit`; defer `ls` and `rg`? | **Yes, conditionally.** `edit` is useful for coding. `bash` can cover many listings and searches, but not every constrained environment. Test discovery, plan mode, missing shell commands, and schemas before making this the default. |
| Q3: Short base schemas and skill search for the helper? | **Use the same base schemas and discovery for all sessions**, after the missing facts and discovery failures are fixed. Do not assume the helper rarely uses skills: Tina wants it to do normal work. |
| Q4: Environment rollback or app setting? | **The environment switch is adequate for an experimental rollout**, provided both rollback switches produce a complete configuration. Add an app setting only if a demonstrated operational need justifies its maintenance. Document restart and recovery. |
| Q5: Default before behavior results? | **No.** Make lean mode opt-in before merge. Decide the default only after the safety and behavior gates pass. The branch currently defaults to lean mode. |
| Q6: One model enough? | **No for a general claim.** One Qwen request proves only that request's size. Measure real payloads for each supported provider family, including `claude-code`. Compare behavior on at least 1 small local model and 1 strong model. |
| Q7: Markdown and owner overrides? | **Yes to Markdown files.** Bundle them and preserve exact rendering. Do not add owner overrides in the same step. Design validation, trust, reload, failure behavior, and rule protection before adding overrides. |
| Q8: Replace `tool_search` and `tool_load` with code mode? | **Not yet, and not as a prerequisite.** Keep a direct discovery fallback until real-model tests and nested-tool parity pass. A script-only `tool_load` cannot promote a native tool under the current nested result handling. Revisit replacement after evidence. |

## 7. Phase order and mergeability

Section 9 has useful goals, but its order does not make every phase a safe, mergeable step.

- **Phase 0:** The size result is good, but the implementation is default-on without behavior evidence. Fix the findings and make it opt-in before merge.
- **Phase 1:** The proposed single `guides` section changes its text on later loads. It does not add 1 new section per guide. An existing `instructions` section also follows extension sections. Inserting `guides` before it can trigger remove-all/re-add-all in `node_modules/@earendil-works/pi-durable/dist/harness/prompt.js:100-117`. The changing `available_tools` section and tool declarations also affect the prefix. This is not yet a fixed-prefix implementation.
- **Phase 2:** Replace the Pia-only cuts with the common lean-helper design above. Keep the owner protections and all 13 tools in the initial target. Resetting `modelTools`, changing rule text, deferring tools, and changing inbox delivery are independent risks. They are not 1 small mergeable step. The manual test must try to **deny** a call, not approve one.
- **Phase 3:** Markdown is the right direction. Moving every guide, tool description, reload path, and documentation page in 1 change is too broad. Split it into independently equivalent moves. Test package contents, exact rendering, placeholders, missing files, hot reload, concurrent reads, and rollback.
- **Phase 4:** This is several projects, not 1 mergeable step. Exposing deferred tools, changing discovery, appending guides, handling promotion, changing nested calls, and replacing direct tools need separate tests and rollbacks. Keep the direct path while evaluating it.
- **Phase 5:** Run 5a before a default change and before building on the untested behavior. Run 5b only after a safe code-mode prototype. Experiments are separate from product changes.
- **Phase 6:** A default decision belongs after the evidence and after a rollback test. It cannot be meaningful while phase 0 is already default-on.

### Proposed sequence

Each numbered item is independently reviewable and mergeable. Keep new behavior opt-in until the decision step.

1. **Repair phase 0 and its rollback.** Preserve instruction and note trust behavior. Fix discovery. Add configuration, schema, lifecycle, and security tests. Keep the full prompt as default.
2. **Run the 5a baseline experiment.** Compare the repaired lean prompt with the full prompt in isolated apps. Publish sanitized inputs, metrics, and results.
3. **Move common prompt text to Markdown without changing behavior.** Follow with separate equivalent changes for helper text and individual guides. Preserve package and reload behavior.
4. **Replace the old phase 2 with the lean-helper split.** Use the same common rules and both name placeholders. Keep the session tools, permissions, workspace, and standing instructions. Measure its actual first request. Gate the new prompt until its behavior is tested.
5. **Implement automatic reports separately**, if the desired scope is confirmed. Keep existing follows correct until then. Do not state that all sessions report before the code does so.
6. **Improve cache behavior in small steps.** Measure actual provider cache usage. Preserve timely changes to owner instructions, plan mode, goals, permissions, and extensions. Do not freeze security-relevant state merely to preserve a cache.
7. **Prototype code-mode discovery and nested-call parity behind a switch.** Keep direct discovery. Split guide delivery and native-tool promotion into later steps if needed.
8. **Run the 5b experiment.** Compare full, lean, and code-mode arms, including helper tasks and safety cases. Then decide whether to keep or remove any direct discovery tool.
9. **Decide the default.** Update documentation and release notes. Verify the rollback on an existing session and on a new session.

### Code-mode blockers for phase 4

- `src/server/extensions/codemode.ts:96-107,294-318` reduces nested results to text. It drops image blocks and does not apply `result.control`. Browser screenshots and design previews return images. A script-only `tool_load` cannot apply `control.addTools` through this path.
- `src/server/memory.ts:852-904` finds notes to preserve after compaction by scanning direct `note_load` tool results. A code-mode-only `note_load` would not create that transcript entry. Preserve this behavior before changing callers.
- `src/server/extensions/plan.ts:322-338` checks annotations against `agent.tools`. A deferred tool exposed only through `agent.callable` is not there. Read-only optional tools can therefore be blocked in plan mode. Test both allowed reads and blocked writes.
- Current code mode calls `tool.execute` itself and runs selected hooks. This is not proof of full native nested-tool parity for callers, output, replay, cancellation, usage, controls, or extension hooks. Compare it with Pi Durable's `executeTool` contract before relying on parity.
- The sandbox has `ALL_TOOLS`, but this integration does not register `searchTools()` or `describeTool()`. These functions need implementation, discovery rules, and tests. A deferred guide returned only after a destructive first call arrives too late.
- A fixed prefix conflicts with immediate owner instruction changes, model/tool selection, goals, plan mode, extension changes, and helper inbox updates. Define the allowed exceptions. Correctness and authorization must take priority over cache savings.

## 8. Missing from the plan

1. **A product contract for instructions.** Define global, project, helper-shared, session, and untrusted content. Define when each is loaded, updated, and authoritative. Include review-only work and shell commands.
2. **A helper reporting contract.** Define automatic reporting, permission boundaries, volume, filtering, duplication, privacy, failure, and shutdown behavior. Current follows are not automatic reports from all sessions.
3. **Real safety acceptance criteria.** Test hostile notes, session output, titles, logs, issues, PR comments, webhooks, and skill descriptions. Test no unsolicited stop, archive, merge, default-branch push, branch deletion, or approval.
4. **A model behavior test with useful power.** Three runs per task can find failures but cannot establish a low failure rate. Include ordinary work by the helper, not only management tasks. Report per-task outcomes and uncertainty, not only a total success count.
5. **A complete experiment protocol.** Pin models, provider versions, prompts, fixtures, enabled modules, tokenizers, cache state, and temperature. Randomize arm order. Record all input, output, latency, retries, failures, cost, and cache usage. Keep live data and credentials out of results.
6. **Lifecycle and compatibility.** Test existing conversations, loaded tools, old hosts, disabled extensions, forks, compaction, reset, restart, instruction changes, and rollback. Do not silently overwrite an owner's `modelTools` selection at compaction or reset.
7. **Budget scope.** Separate system text, tool schemas, user input, provider wrappers, and first-turn tool results. Define the fixture and supported provider for each budget. Permit explicit owner content and required security updates to exceed a fixed target.
8. **Markdown operations.** Specify packaging, placeholder escaping, atomic reads, reload behavior, missing or invalid files, override precedence, trust, and recovery. Do not replace enforced code checks with editable prompt text.
9. **Accessibility and delivery.** Preserve images, attachments, board instructions, agent message formatting, and clear links. Test these in a normal session and in the helper.
