# Codemode migration: work in progress

**Do not deploy this branch or use the experimental executor for work.** The native executor does not yet preserve Pia's note-retention and nested-approval display contracts. Codemode-only mode is not implemented. This note records the evidence and the remaining release gates.

## Compatibility

The starting branch pins the `@earendil-works` packages at 1.4.0. The npm registry listed 1.5.0 as the newest version on this investigation. The local upgrade commit `d6a3bbca` moves the compatible package set to 1.5.0. This branch applies it with conflict resolution for the later Pia features. The lockfile pins the resolved versions and integrity hashes.

Pi Durable 1.4.0 already has `createCodemodeExtension`, `agent.callable`, and `executeTool()`. The previous prototype's conclusion that 1.4.0 has no native executor is not correct for the installed package. Version 1.5.0 fixes `read` of images in native codemode and changes search ranking. Its nested executor applies tool argument validation, hooks, cancellation, and tool replay policy. Nested result controls do not apply. In particular, do not forward arbitrary nested `control.addTools` values. Pia's direct `tool_load` remains model-only.

Upstream Pi Pocket 0.28.0 issue #260 adds an owner-selected Only mode by wrapping tools as `callers: ["tools"]` and listing their schemas in the prompt. It retains a separate codemode executor. It also leaves some UI-dependent tools direct. It is not the same as the native Durable executor. This branch does not fetch or merge upstream history.

**Back up the complete data folder with the service stopped before a 1.5 upgrade.** Pi Durable 1.5 writes newer durable document and task versions. Older code cannot reliably resume or read data written by 1.5. Restore the complete pre-upgrade backup to roll back the data. Turning a codemode mode off does not restore the data. A copied-data upgrade and backup-restore test remains required. Never run that test on the live data folder.

## Current branch

The existing executor stays the default. `PI_POCKET_EXPERIMENTAL_NATIVE_CODEMODE=on` selects the native executor for isolated development tests only. It is not a rollout setting. Do not set it on a live service. The native and existing executors use different store documents (`pi.codemode.store` and `pocket.codemode-store`); existing `store()` values do not migrate. Native nested call details also have a different shape. The Changes sheet and live nested approval presentation need integration. The old stored document definition remains unchanged.

The isolated faux-model test covers one deferred registered extension: native `searchTools()` and `describeTool()` find it, and the same script calls it without adding a model-facing schema. A separate real tool hook blocks a nested call. The test also checks a model-only tool and a conversation-excluded tool cannot be called by guessed names. These tests do not establish all approval, permission, cancellation, image, or recovery behavior.

## Owner's configured extensions

The live configuration was read only. Its explicit enabled list is `ink-board.ts`, `pip.ts`, `session-tags.ts`, `tt-providers.ts`, and `tt-usage.ts`. Its explicit disabled list is `agent-teams.ts`, `artifacts.ts`, `background.ts`, `design.ts`, `gallery.ts`, `goals.ts`, `subagents.ts`, `triggers.ts`, and `updates.ts`. The source default and the two lists also select prompt, browser, schedules, plan, codemode, memory, inbox-notes, compaction-review, and restart; guard, anthropic-subscription, and ask-someone default off. The drop-in folder contained no extension source files. A configured selection is not proof that a module loaded successfully. No live setting was changed.

Do not copy upstream direct exceptions for unused artifacts or design tools. Choose exceptions from the enabled inventory and their actual UI needs. `memory` needs an owner-visible proposal queue; `ink_read` and browser need an image path that reaches the model; an interactive tool that asks a person needs a visible approval path. Test each before choosing direct or nested exposure. Pia chat needs an explicit mode decision; do not silently force it into Only mode. Do not enable background jobs or add a job system.

## Remaining gates

- Implement reversible mode selection in the existing extension settings pattern. Preserve lean/full and discovery rollback. Test old direct calls and Pia chat explicitly.
- Preserve notes actually read, not search hits, across compaction and across the correct branch and reset boundaries. Resolve IDs again against current scope and current approved content. Preserve old direct-result history. A nested result is not a top-level `note_load` result, so the existing scan cannot prove retention.
- Retain discovered tool names, not complete schemas, across compaction. Resolve them against current enabled tools and permissions. A retained name must not grant access. Test disabled and excluded tools.
- Agent-written notes are proposals. A proposal must remain unavailable as memory, including in its originating session, until the owner explicitly approves it. Verify the owner can find and edit nested proposals in the approval queue. Direct-result inline cards alone do not establish a nested UI path.
- Test actual guards and approval cards, session isolation, cancellation, image and structured results, registered tools, file tools, permission boundaries, and recovery. Test Ink Board only with isolated fixtures or safe read-only operations. Test the full acceptance checklist before release.
- Update starting-tool and prompt-cost documentation, and remove mode-specific prompt contradictions. Skill metadata discovery can be a separate follow-up; use `host.skills(cwd)` and preserve trust and model-disabled filtering. Keep full project `AGENTS.md` context.
- Run the requested real-model comparison with isolated fixtures and record usage and exact failures. No real-model smoke test was run for this partial branch.
