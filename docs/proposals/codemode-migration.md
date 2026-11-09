# Native codemode migration

## Decision

Use one Pi Durable 1.5.0 executor in both modes. The old sandbox executor and manual hook runner are removed. **On** remains the default. **Only** is an owner-selected setting under Extensions → Codemode. Pia chat stays in On unless the owner also selects **Use Only in Pia chat**. No live setting was changed. This branch is not deployed.

The dependency change is separate: `29a8ca47` applies local upgrade commit `d6a3bbca`, with conflicts resolved for the later Pia features. The lockfile pins the compatible 1.5.0 package set. The earlier experimental slice is `84ccc34d`; its environment switch no longer selects an executor.

## Comparison and compatibility evidence

- The starting package set was 1.4.0. The npm registry listed 1.5.0 as latest during this task. Both versions have `createCodemodeExtension`, `agent.callable`, native discovery, and `executeTool()`. The earlier prototype's conclusion that 1.4.0 lacked a reusable native executor is not correct for the inspected package.
- Version 1.5.0 fixes image reads in native scripts and changes tool-search ranking. Its executor supplies argument validation, guards, replay, cancellation, structured results, and output budgets. Pia does not copy those implementations.
- Native nested results do not apply controls. Pia does not forward nested `control.addTools`. Direct `tool_load` and `tool_search` stay model-only. Deferred enabled script tools need no load step. Native search, schema discovery, and execution can occur in one script without permanent direct-schema expansion.
- Upstream Pi Pocket 0.28.0 issue #260 adds Only through tool wrappers and a prompt catalog, but retains a separate executor. This task inspected the GitHub release and source read-only. It did not fetch or merge upstream history. It inspected the local Terra prototype and companion compatibility commits, rather than copying the prototype.
- Durable 1.5 classifies tool calls against the stored request, before a `beforeRequest` declaration filter. Thus Pia also rejects hidden direct calls in `beforeTool`. A provider cannot bypass Only by guessing a direct call. Stored history is not rewritten.

## Store transition and rollback

On first native use, `pocket.codemode-transition` copies legacy `pocket.codemode-store` keys into `pi.codemode.store` once. Existing native values win on a key conflict. The old store stays intact, including conflicting values. The transition merges missing legacy keys; it cannot reconstruct deletions made by an earlier experimental executor. On/Only switches share one native store and never repeat the import. Tests cover conflicts, failed-script writes, mode switches, session separation, and reopen.

The old document definition remains unchanged: conversation scope, latest history, current fork. The native store has rewindable history and forks as of the fork point. A fork before the transition uses the old document's existing fork rules on its own first native use. A fork after the transition inherits native values at its fork point.

**Back up the complete data folder with the service stopped before upgrading.** Pi Durable 1.5 writes document and task versions that older code cannot reliably read or resume. A mode switch is not a data rollback. To return to 1.4, stop the new service and restore the complete pre-upgrade backup. Do not open live data with old code as a test.

A synthetic data test used source at `8c3fc3ef` and its exact 1.4.0 dependencies, then the writer's 1.5.0 code, then a restored backup with 1.4.0. All three stages passed. Direct results, nested results, images, and tool errors remained readable after upgrade. The old store value was copied and remained readable. No live database was copied or opened.

| Stage          | Durable | SQLite `durable_schema` | `pi.live` definition | `pi.tool` | `pi.generation` | Entries after the stage |
| -------------- | ------- | ----------------------- | -------------------- | --------- | --------------- | ----------------------- |
| Seed           | 1.4.0   | 2                       | 1                    | 2         | 1               | 16                      |
| Upgrade        | 1.5.0   | 2                       | 3                    | 3         | 2               | 20                      |
| Restore backup | 1.4.0   | 2                       | 1                    | 2         | 1               | 20                      |

The restore stage started from the 16-entry backup and added its own test turn. The definition versions above come from each dependency. The physical storage schema stays at 2; this does not make document or task versions backward-compatible. The repeatable manual test is `test/codemode-upgrade-exercise.ts`. Logs are `/tmp/pia-upgrade-final-{seed,new,restore}.log`.

## Enabled inventory and direct exceptions

The live configuration was read only. Explicitly enabled: `ink-board.ts`, `pip.ts`, `session-tags.ts`, `tt-providers.ts`, `tt-usage.ts`. Explicitly disabled: `agent-teams.ts`, `artifacts.ts`, `background.ts`, `design.ts`, `gallery.ts`, `goals.ts`, `subagents.ts`, `triggers.ts`, `updates.ts`. Source defaults also select prompt, browser, schedules, plan, codemode, memory, inbox-notes, compaction-review, and restart. Guard, anthropic-subscription, and ask-someone default off. The drop-in folder had no extension source files. This is the configured selection, not proof that every module loaded successfully.

Only keeps these direct paths when enabled and available:

| Path                                      | Reason                                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `codemode`                                | Runs scripts. It cannot call itself.                                                                                       |
| `browser`                                 | Images and interactive forms need its own card in Only. On keeps script access.                                            |
| `ink_read`                                | Markup images need direct model/UI delivery in Only. On keeps script access. Other Ink Board tools remain script-callable. |
| Explicit model-only registrations         | Preserve the extension author's caller boundary. Never make them script-callable.                                          |
| `tool_load`, when a direct UI tool exists | Load a deferred UI declaration on the next request. It rejects ordinary script-tool names in Only mode.                    |

There is no artifact or design exception. `memory` is not a direct Only exception: nested proposals reach Memory and the owner's cross-project pending queue. Inline cards are optional. Script-callable notes do not expand the model-facing schema list. No background jobs or job system were enabled or added.

## Retention, approval, and presentation

A small adapter observes native discovery results. It saves names, not declarations, before delivery. It records approved note IDs returned by `note_load`, not `note_search` hits. Per-task metadata survives replay and enters the outer tool result, including Stop and error results. A shared fork-aware history scan reads those references before compaction and stops at a reset. It also reads old direct `note_load` history. Tool-name retention works independently of the Memory extension.

Before reinjection, note IDs resolve against current approved content and current scope. Tool names resolve against current enabled callable registrations. Neither reference grants access or bypasses a guard. The scan is repeated against the current head; it has no timestamp/summary-length cache that can confuse two compactions. Large active histories can therefore cost more history reads; inactive knowledge-base sessions do not run the scan.

All agent-written notes remain proposals. Pending text is excluded from reads, search, and retained-note injection, including in its originating session. The owner can find and edit nested proposals in the existing queue. An edit now leaves a pending proposal pending. A separate explicit approval is required. Tests check edited approved content, provenance, separate sessions, compaction, forks before and after a read, reset, removal, and scope changes.

Native write/edit wrappers durably record the actual validated path before child success. Changes uses that applied receipt, not a live slot or the truncated argument preview. A confirmed receipt remains usable if Stop or timeout prevents delivery to the parent script. Native nested progress uses the parent card's existing call list. Guard approvals attach to that card but retain unique nested call IDs and separate allow/deny decisions. Plan mode resolves nested annotations from `agent.callable`.

## Verification

Automated tests cover file read/write/edit, shell grep, registered and deferred tools, schema discovery, no next-request expansion, direct-mode loading, model-only and configure-excluded tools, separately disabled extensions, individual rejection messages, zero forbidden fixture executions, structured errors, image reads, stream output, parallel approvals, timeout cancellation, Stop metadata, and native journal recovery after close/reopen. The store tests use isolated data. Existing direct history remains visible after mode changes. Pia's independent mode choice is tested.

Ink Board uses a mocked isolated service and fixture token. The test checks images, links, service identity, and that an unidentified service gets no command or token. Usage tests load the actual extension with every account disabled; no credential or network lookup is needed. They check owner access and guest rejection. Live Ink Board state, real usage endpoints, provider sign-in/refresh, and browser form UI were not exercised against real services.

The full suite first had an artifact UI timeout; that file passed alone. A later full run had one design UI width assertion (`1920`); that file also passed alone (18 tests). The pre-review final full run passed all 1,055 tests. `npm run format` ran on a throwaway source copy; only task-owned files were copied back. Final `npm run check`, `npm run lint`, and `git diff --check` passed. These results do not erase the earlier full-run failures.

## Real-model smoke tests

The manual runner is `test/codemode-model-smoke.ts`. It uses temporary credential copies and isolated fixtures. Both models receive the same task and files. Independently expected values: Amber has 4 lines, first heading `# Amber`, 1 TODO; Birch has 5 lines, first heading `# Birch`, 2 TODOs; status is `ready`, queue 0; the approved convention requires `# Fixture Report`. No project README or memory proposal was changed by the test.

Two runs per model were made. Between runs, the Only guide was clarified and the unused UI-load declaration was removed when no UI tool exists. These are not controlled performance comparisons. The earlier manifest metric captured an auxiliary request, so `offered: []` is not a valid measurement of the initial conversation declarations. The runner now captures the first request that includes codemode; the recorded runs did not capture that corrected metric. Faux-provider tests verify the actual declaration filter. Request counts below include auxiliary requests. Retries were disabled. No transport error or retry was recorded.

| Run | Model / reasoning                                        | Requests | Fresh input | Cache read | Cache write | Output | Wall seconds | Result                                                                                                                                                      |
| --- | -------------------------------------------------------- | -------- | ----------- | ---------- | ----------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `openai-codex/gpt-6-luna`, xhigh                         | 7        | 13,355      | 2,816      | 0           | 1,602  | 51.65        | Correct report. One `tool_load` call was blocked.                                                                                                           |
| 1   | `local-inference/strata/qwen3.8-flash-next-iq3_xxs`, off | 7        | 3,523       | 13,624     | 0           | 1,577  | 103.28       | No report. One script failed: `ReferenceError: note_search is not defined`. The model later emitted a text `<tool_call>` for write instead of executing it. |
| 2   | `openai-codex/gpt-6-luna`, xhigh                         | 8        | 11,006      | 7,680      | 0           | 1,329  | 44.82        | Correct report. No tool failure.                                                                                                                            |
| 2   | `local-inference/strata/qwen3.8-flash-next-iq3_xxs`, off | 2        | 1,818       | 0          | 0           | 470    | 73.83        | No report and no executed tool call. The answer was text `<tool_call>`.                                                                                     |

Run 1 direct calls: Luna, 4 codemode and 1 load; Strata, 5 codemode. Run 1 nested calls: Luna, 7 successful calls (note search, bash, note load, status, two reads, write); Strata, 9 successful calls across 5 scripts, with the script-level reference error above. Run 2 direct calls: Luna, 6 codemode; Strata, none. Run 2 nested calls: Luna, 8 successful calls (4 bash, note search, note load, status, write); Strata, none. Usage is the session's recorded model usage; it is not a claim about server-wide usage. Logs are `/tmp/pia-codemode-model-smoke{,-2}.log`. Run 1 completed both model records but its process later hit the shell timeout while idle transports remained. Run 2 exited normally. Temporary credential copies were removed after the tests.

**Strata does not pass the model acceptance task.** Keep Only opt-in. Do not claim that a single model run proves a performance benefit. Provider/parser investigation is a separate follow-up; this migration does not turn text that looks like a call into an executed call.

## Remaining limits

- Do not deploy without the owner and independent review. Mode rollback is available; dependency rollback requires the backup.
- The Strata model gate failed, and the initial real-model declaration metric was not captured correctly. Do not mark those gates passed.
- The crash test covers native journal recovery on isolated close/reopen, not a hard process kill or a changed VM fingerprint.
- Live external integrations and browser-rendered approval interactions remain untested. Backend parent-card mapping and the existing approval API were tested.
- A skill-metadata path remains a separate follow-up. Use the validated `host.skills(cwd)` loader, preserve winning paths, trust filtering, and model-disabled exclusions. Skills are not tools. Full project `AGENTS.md` context is unchanged.

## Retention API review follow-up

The earlier optional `HookApi` cast in Memory was already removed in `49c75fe7`. The review found two remaining casts in codemode. Those are now removed too. Built-in hooks read the agent and active head through `host.history`, which delegates to the supported native `Conversation.agent()` and `Conversation.context()` methods. No hook assumes HookApi exposes those methods or falls back to an empty callable list. Retained notes resolve with the current native cwd before the approval and scope checks.

Tests now inspect actual post-compaction injection, not just result metadata: a fork before discovery has neither reference; a fork before the note read has the discovered tool name but no read note; a fork after the read has both; a reset has neither. Current approved note text is injected only in scope. A cwd change excludes the old project note. Tool-name injection still works with Memory disabled. An exact HookApi fixture with no agent/context methods exercises both hooks. The native executor remains the only executor in both modes. No real-model smoke test was repeated for this API-only follow-up; the Strata and metric limits above remain.

Follow-up verification: `npm run format` passed on a throwaway source copy, with only task-owned files copied back. Type checking and lint passed. The 15 focused native, note, history, and injection tests passed. The first full run passed 1,054 of 1,055 tests; the existing artifact follow-up timeout failed again. That file passed all 10 tests alone. The final full rerun passed all 1,055 tests. The earlier failure remains recorded in `/tmp/pia-retention-review-full.log`; the passing full rerun is `/tmp/pia-retention-review-full-rerun.log`. No live data, settings, or service changed.

## Independent review fixes: UI mode scope and durable Changes

1. The global `callers: ["model"]` wrappers for browser and Ink Board reads were removed. On keeps the original script access. Only filters these two names from the script catalog for that conversation and rejects nested attempts through a tool hook. Direct UI calls remain available. Pia's independent On choice is preserved. Isolated native-registry tests check script execution counts, discovery, guessed calls, direct calls, an indirect nested caller, switching back to On, and Pia's separate setting. These tests do not contact live Browser or Ink Board services. On keeps the prior text-return contract for schema-less script results; use direct UI calls for their images.

2. Attribution no longer reads `LiveDoc` or swallows live-slot lookup errors. A write/edit wrapper receives the final validated path after hooks rewrite arguments. It reads the durable task's parent/key with `api.getTask()` and commits the successful applied path into the parent's task document before returning child success. The result's `applied: true` receipt is preserved by light projection and workspace edit-fact caching. Native script-call status is not changed. Thus a file write can remain attributed even when the script times out before receiving its result.

`test/codemode-changes.test.ts` calls the actual `app.workspace.changes()` API. It checks native write and edit attribution in On and Only; a hook-rewritten path longer than the 200-character argument preview; a denied write; and a parent whose live-slot reader throws. It also stops the parent after the child result commits but before the parent receives it. The test queries Changes while the parent is still running, checks attribution when the stopped parent publishes its result, and checks again after reopen. A timeout case checks the same durable applied receipt. These are workspace assertions, not result-detail-only assertions.

**Precise limit:** filesystem writes and durable metadata are not one transaction. If Stop, process loss, or an I/O failure interrupts the operation before its successful file-operation return and attribution commit, the file can change without a confirmed receipt. It remains visible in Changes, but `byPi: false` is then unconfirmed attribution. While a parent is still running, Changes can list its file without attribution because its result is not yet in the transcript. The code does not guess the original path or commit after cancellation. The injected attribution-commit-failure test proves that the file effect is visible, the tool reports failure, and attribution is not falsely confirmed.

3. Supported retention readers were committed in `7166ee50`: both hooks use native `Conversation.agent()` and `Conversation.context()` through the read-only host reader. No optional HookApi agent/context cast remains in Memory or codemode. Hook, fork, reset, current-scope, and actual-injection tests are rerun on the same code as these fixes. The host-reader test compares resolved declarations, not execute-function identity: registry wrappers can create fresh closures at each resolution. Both modes still use one native executor.

Session 170373's full report was not accessible through the available session tools. The concrete findings supplied in Pia's message were used. No live data, settings, service, merge, deployment, or restart changed. The earlier Strata and real-model metric limits remain; no real-model smoke run was repeated for these fixes.

The first full run for these fixes passed 1,060 of 1,061 tests. One Design UI test timed out waiting for a slide to scale to its frame. All 18 tests in that file passed on an isolated rerun. Targeted checks passed all 28 native, Changes, mode, hook, fork/reset, scope, and plan tests. These results do not erase the full-run timeout. The final default parallel rerun had the same result: 1,060 passed, 1 failed at the same Design slide-scaling timeout. Check and lint passed on that code, and all 28 targeted tests passed again. The default suite is not green; do not waive this release gate. Logs are `/tmp/pia-review-final-full.log` and `/tmp/pia-release-review-full.log`.

A serial full-suite attempt (`node --test --test-concurrency=1 test/*.test.ts`) exceeded the 480-second shell limit after 888 passes and no recorded test failure. It did not complete, so no serial full-suite pass is claimed. The Design case passed in that run. Its log is `/tmp/pia-review-full-serial.log`. The 18-test isolated Design run passed (`/tmp/pia-review-design-isolated.log`). This evidence does not establish the cause of the parallel failure. The migration fixes are committed for independent review, not release or deployment.
