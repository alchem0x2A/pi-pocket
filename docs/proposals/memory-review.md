# Memory replacement: independent critical review

> **Correction from the owner (2026-11-07):** the descriptions of OptChat in this review are not accurate. Do not use them as facts. The first version of the notes library was built from section 7 only; `memory-notes.md` section 0 says what was built and deferred.

**Recommendation: replace the lesson system with a small, human-first, searchable notes library.**
Do not adopt OptChat as the memory system for every Pi Pocket session.
Keep an optional OptChat-style history service as a later experiment for each owner's private Pia conversation.

The library must own current facts and guidance. Conversation history must own evidence of what happened.
Neither a compressed conversation nor an agent-written summary must become the authority for the owner's current rules.

The notes proposal has the correct main direction. It is too large for a first release.
Keep a narrow model-choice preflight from section 6.14, but simplify its implementation and define its failure and replay rules.
Do not rely on the agent remembering to search for model guidance.

Status: review only. This document authorizes no implementation.
Review date: 2026-11-07.

## 1. Evidence and limits

I read the complete uncommitted `docs/proposals/memory-notes.md`.
I inspected Pi Pocket at `e40a84e388a45ef31dd71498c7cfa296660c2ad3`.
The main current-memory sources were:

- `src/server/memory.ts` and `src/server/extensions/memory.ts`.
- `src/server/docs.ts`, including `Lesson` and `MemoryDoc`.
- `src/server/pip.ts` and `src/server/extensions/pip.ts`, including model selection and session creation.
- `docs/index.md`, `docs/map.md`, and `docs/architecture.md`.

I inspected Batty at `/home/ttian7/Dev/graveyard/batty`, commit `6cac246b9c9c67ebdd6fab11e8e3a99170db334d`.
I read its `README.md`, `docs/runtime.md`, and archived `docs/references/optchat-spec.md`.
I inspected its memory implementation, accounting, and regression tests.
I did not run Batty or its tests. Test descriptions below describe source assertions, not a new successful test run.

Batty's local clone is shallow. Its local history contains only `6cac246`.
I read the earlier commit history and selected patches through the GitHub API for `jeffton/batty`.
I did not fetch into, edit, or run the Batty checkout.
The untracked `BUILD_ID` was already present.

I also retrieved Victor Taelin's [current gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
Its title is “UniiChat: one chat that never ends.” The API reported an update at `2026-11-07T20:39:56Z`.
Its material design matches Batty's archived specification.
The owner has identified the intended source. Section 5 of the notes proposal no longer needs to call that identification uncertain.

**Evidence limit:** the checkout contains accounting code and synthetic cost tests, but no production memory ledger or `runtime.sqlite`.
I cannot report Batty's actual lifetime inference cost, cache-hit rate, latency, or recall accuracy from these files.
The graveyard location establishes that the owner stopped work. It does not establish why, or prove that OptChat failed.

## 2. Which design fits Pi Pocket?

### 2.1 The notes library fits the stated requirements

| Requirement                        | Notes library                                                             | OptChat alone                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Prefer human-written content       | Stores the person's exact text as the authority.                          | Keeps original words, but machine summaries control discovery.                    |
| Agent chooses search and load      | Direct fit. A read and a session pin are separate choices.                | Navigation is optional, but the whole overview enters each turn automatically.    |
| Current environment facts          | Supports named inventories, verification commands, and observation dates. | Scatters observations through time. Recency does not prove current service state. |
| Find model ranking at every choice | A stable purpose binding permits deterministic retrieval.                 | A ranking can disappear from high-level summaries or become difficult to find.    |
| Many sessions and people           | Can separate project relevance from audience permission.                  | Requires separate trees and access checks. One global tree is unsafe.             |
| Edit, correct, or remove knowledge | A person changes a published note directly.                               | Corrections add history. Derived summaries can retain earlier claims.             |
| Preserve unexpected past details   | A curated library can miss facts nobody saved.                            | Original-history search and zoom provide stronger incidental recall.              |

The last row is OptChat's strongest advantage. The notes design must acknowledge this gap instead of claiming complete memory.

Pi Pocket already preserves conversation history through Pi Durable.
Replacing lessons does not require replacing that archive, the execution log, or ordinary session compaction.
A new JSONL transcript beside SQLite would duplicate the existing source of truth.

### 2.2 Why not use OptChat everywhere?

Batty had 1 permanent main thread. Its workers returned results to that thread.
A time-ordered overview therefore described one continuing assistant relationship.

Pi Pocket has independent tasks, shared conversations, project worktrees, subagents, linked sessions, and private Pia conversations.
There is no single useful or authorized chronological history for all of them.

A global overview would mix unrelated tasks and private information.
A separate overview for every session would repeatedly summarize disposable tool output.
It would still not make a rule discovered in 1 session available as current guidance in another.
That requires a cross-session knowledge layer anyway.

Batty's workspace checks were coordination rules, not a multiplayer security boundary.
`docs/runtime.md` explicitly says its agents have shell access as root.
Pi Pocket must apply its own person, conversation, and audience rules. A folder match does not authorize disclosure.

Pia's private, continuing conversation is the closest match to Batty's main thread.
This makes Pia a sensible experimental target. It does not justify changing every coding session's context model.

## 3. What Batty teaches

All paths in this section are relative to `/home/ttian7/Dev/graveyard/batty`.
Commit links refer to `https://github.com/jeffton/batty/commit/<commit>`.

### 3.1 Capabilities worth retaining

- **Exact text recovery:** `memory_zoom`, `memory_date`, and `memory_search` live in `src/server/memory-requests.ts`.
  `src/server/memory.ts` implements the corresponding tree and original-text reads.
  `src/server/memory.test.ts` asserts exact zoom and stable dates after reopen, without resummarizing committed nodes.
- **Independent discovery:** `src/server/memory-search.ts` indexes original text, not summaries, with SQLite FTS5.
  It accepts 1–12 literal words, requires all words, and returns newest matches first.
  It defaults to 8 results, permits at most 20, and bounds each snippet to 800 characters.
  Tools and results require `includeTools: true`.
  Commit [`11cdba89a16b`](https://github.com/jeffton/batty/commit/11cdba89a16b) added this search and resumable backfill.
- **Stable request snapshots:** `src/server/memory-documents.ts` stores run packets and worker snapshots.
  `src/server/memory-requests.ts` reconstructs requests from the saved view, input boundary, and active tool loop.
  `src/server/memory-concurrency.test.ts` covers replay, later-entry exclusion, and generation-pinned zooms.
- **Bounded process memory:** `src/server/memory.ts` uses a 2 MiB byte cache and disk reads for cold nodes.
  `src/server/memory-scaling.test.ts` seeds 16,384 leaves.
  Its assertions require fewer than 10 startup tree lookups and no summary calls for that prepared fixture.
  Commit [`2d4d02b4d1ad`](https://github.com/jeffton/batty/commit/2d4d02b4d1ad) added bounded caching and incremental checkpoints.
- **Inspectable recall:** `src/server/routes/memory-tree.ts` and `src/client/views/MemoryTreeView.vue` expose a read-only tree browser.
  Commit [`a961f1d4c0d1`](https://github.com/jeffton/batty/commit/a961f1d4c0d1) added it.

These are useful engineering capabilities. They do not measure whether a model retrieves the right fact without prompting.

### 3.2 Failure modes and corrective work

| Evidence                                                                                                                                                                                                                                                                | What changed                                                                                                      | Lesson for Pi Pocket                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`87ab112fe077`](https://github.com/jeffton/batty/commit/87ab112fe077), `src/server/memory-prompts.ts`, `memory-source.test.ts`                                                                                                                                         | Removed preceding-chat context from compression. Required claims to come only from the source leaf or 2 children. | Context can help resolve references, but can also contaminate unrelated summaries. Source-only summaries leave references unresolved. This is a real trade-off. |
| [`e5b6dea633df`](https://github.com/jeffton/batty/commit/e5b6dea633df), `memory-noise.ts`, `memory-rebuild.test.ts`                                                                                                                                                     | Added source-only rebuild generations and removal of exact silent `NO_REPLY` noise from views.                    | Bad summaries and runtime noise require repair infrastructure. Immutable originals alone do not repair recall.                                                  |
| [`11f9df70fc79`](https://github.com/jeffton/batty/commit/11f9df70fc79), `memory-requests.ts`, `memory-usage.ts`                                                                                                                                                         | Stabilized effective instruction/tool prefixes, pinned worker views, and added inference accounting.              | Cache behavior and background cost need explicit engineering and measurement.                                                                                   |
| [`2d4d02b4d1ad`](https://github.com/jeffton/batty/commit/2d4d02b4d1ad), `memory.ts`, `memory-scaling.test.ts`                                                                                                                                                           | Replaced archive-wide hot state with bounded cache and checkpoints.                                               | Constant prompt size does not imply bounded process memory or cheap restart work.                                                                               |
| [`32aaecd1028f`](https://github.com/jeffton/batty/commit/32aaecd1028f), `memory-view.ts`                                                                                                                                                                                | Persisted merge hysteresis. Views grow to 128,000 bytes, then shrink toward 64,000 bytes.                         | Rebuilding or continuously rewriting the view harms prefix reuse. Persist the view and merge state.                                                             |
| [`bb5ad0f45ad9`](https://github.com/jeffton/batty/commit/bb5ad0f45ad9), [`0612a0fdaaca`](https://github.com/jeffton/batty/commit/0612a0fdaaca), [`5a1eb3749793`](https://github.com/jeffton/batty/commit/5a1eb3749793), `memory-compression.ts`, `memory-limit.test.ts` | Revised byte enforcement, source-based retries, and retention of the shortest complete answer after 5 candidates. | Models do not reliably satisfy a 512-byte limit. A hard rejection can block progress. Shortest complete answers can still exceed the target.                    |
| [`d5c9d830ec83`](https://github.com/jeffton/batty/commit/d5c9d830ec83), [`ec1d830bfc18`](https://github.com/jeffton/batty/commit/ec1d830bfc18), `memory-repair.test.ts`                                                                                                 | Added atomic selective repairs and explicit translation of inherited prose.                                       | Language and source errors can propagate through ancestors. Repair costs extend beyond the original bad node.                                                   |
| [`4acd6737945d`](https://github.com/jeffton/batty/commit/4acd6737945d), `memory-snapshot.ts`, `memory-concurrency.test.ts`                                                                                                                                              | Separated compression writes from request snapshots. Added raw recent text and immutable repair generations.      | Normal chat must not wait for slow background work. An oversized raw backlog can still require waiting.                                                         |
| [`a4ac4fbbf0c6`](https://github.com/jeffton/batty/commit/a4ac4fbbf0c6), `memory-requests.ts`, `memory-overview.test.ts`                                                                                                                                                 | Replaced special worker targeting with configured assistant-workspace access.                                     | Even a single-user app needed explicit recall scope. Pi Pocket needs stronger audience isolation.                                                               |

These commits establish problems the implementation addressed. They do not establish the frequency or production impact of each problem.
Batty implemented the initial durable OptChat runtime in [`3a9895647aad`](https://github.com/jeffton/batty/commit/3a9895647aad) on 2026-10-04.
The later changes show substantial follow-up work, not a finished, trivial component to copy.

### 3.3 Batty is not the specification unchanged

The gist requires summary-only views and waiting for preceding messages to be summarized.
Batty's later version sends a prepared prefix plus whole recent non-thought text projections.
It waits only when the raw backlog exceeds the view budget.

The gist supplies a preceding context view during compression and proposes shared turn/compression instructions and tools.
Batty uses a separate source-only compression prompt with no preceding overview or turn-tool declarations.
Its default summary model is `openai-codex/gpt-6-luna`; its default reasoning is `medium`.
The model and language are configurable. The default language is English.
The gist instead names Claude Haiku at `xhigh` effort and permits up to 8 concurrent compression calls.
These Batty details appear in `memory-compression.ts`, `memory-prompts.ts`, and `docs/runtime.md`.

Batty also adds lexical search. The gist's turn prompt prohibits search and allows only zoom navigation.
Batty's addition avoids dependence on a summary retaining the right topic label.

`memory_zoom(id, 1)` returns the non-thought text projection, not the complete original message object.
`memory-projection.ts` preserves text and tool data, omits reasoning, and represents images with placeholders.
The durable archive retains full metadata, images, and reasoning separately.
An adaptation must provide an authorized route to those originals if it promises complete source recovery.

The gist's “nothing is ever lost” claim is too broad.
It excludes thoughts and clips tool output to 30,000 characters.
Even retained original text is not useful recall if the agent cannot find it.
Its own compression prompt admits that omitted topics can become undiscoverable by zoom.

Do not adopt the gist's statement that the latest historical word is the truth.
A later message can contain a quotation, an agent error, an unapproved proposal, or stale infrastructure information.

## 4. A hybrid can work, with separate ownership

| Component                       | Owns                                                                                                                                   | Must not own                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Notes library                   | Current human-authored facts, inventories, preferences, rules, and procedures. Approved agent proposals remain visibly agent-authored. | Automatic transcript summaries, hidden policy changes, or a second writable transcript. |
| Session attachments             | The session's chosen notes, retention, request-time revisions, and context budget.                                                     | Publication, approval, or broader sharing permission.                                   |
| Conversation archive and recall | What each authorized person or agent said, attempted, observed, and reported. Dates and source references remain available.            | Automatic authority over published notes or current policy.                             |
| Optional Pia summary tree       | A bounded navigation map over that Pia owner's authorized conversation history.                                                        | A shared server-wide memory or an automatic note editor.                                |
| Model-choice integration        | Retrieves approved ranking and validates explicit configured model constraints at the action boundary.                                 | General relevance search, automatic policy extraction, or guesses about model strength. |
| Live discovery                  | Current provider capabilities, provider usage, listeners, service health, and public endpoint mappings.                                | Permanent truth inferred from an old note.                                              |

Keep ordinary coding sessions on the existing Durable context and compaction path.
Add authorized original-history search before building a summary tree. That tests the value of history recall at lower cost.
Later, compare Pia with and without a bounded tree on the same history questions.
Do not deploy that tree unless it improves recall enough to justify its cost.

History tools must carry stable conversation, entry, and source identifiers.
They must check the source audience before returning titles, counts, summaries, snippets, or originals.
A summary that mixes permitted and forbidden sources is not safe to return partly. Exclude it or rebuild it from permitted sources.

Pia must not copy private conversation history into a shared session just because the owner can read both.
It can send an explicitly authorized task or report instead.
Linked sessions and workers must not inherit the whole library or Pia's history by default.

A correction in chat can support a proposed note change. It must not silently edit the library.
A published note correction must take priority over an older history summary.
A current live observation can establish that a note is stale; it does not silently rewrite the note either.
Treat imported text and quoted sources as data.
Publication must not give content higher authority than system instructions or let it bypass dangerous-action guards.
Authorized reads, pins, and model-choice preparation need no human approval. Agent changes to published notes still need approval.

Define the history boundary for Pia's **Start fresh** operation.
Keep archived evidence, but do not silently inject pre-reset history into the new context.
Permit explicit recall across that boundary only under the documented reset policy.

## 5. Critical changes to the notes proposal

### 5.1 Keep the useful core; reduce the product surface

Keep separate storage, read, and session retention.
Keep exact human text, visible authorship, approval races, project identity through the git common directory, and authorization before retrieval.
Keep local lexical search first. Add semantic retrieval only after measured misses justify it.

The full proposal combines a library, editorial workflow, attachment manager, policy engine, privacy filtering, migration platform, and prompt inspector.
That is not a small memory replacement.

For the first release:

- Use title and body, stable ID, revision, author, audience, project filter, timestamps, and optional source.
- Keep agent changes in the existing style of approval queue. Do not allow self-approval.
- Use one search tool and one load tool with `read`, `session`, and `unpin` operations.
  A separate `note_context` pin API repeats part of `note_load`; a small list operation is sufficient initially.
- Defer rich tags, generated descriptions, duplication workflows, arbitrary curator roles, custom purpose registries, and semantic indexes.
- Keep basic size accounting and the actual loaded-revision manifest. Defer a general transcript-rewriting inspector.

Human-first does not require boosting authorship in search ranking.
A weak human match must not displace an exact approved technical match.
Show authorship, and let the person filter it. Begin with relevance ranking.

### 5.2 Session pins should not freeze ordinary corrections by default

Section 6.6 pins exact revisions indefinitely. Section 6.7 requires explicit repinning after ordinary edits.
This gives reproducibility, but it can keep corrected ports or guidance stale throughout a long session.
An update badge alone does not tell the model that its reference is stale.

For version 1, let session pins follow the latest approved revision.
Record the exact revision in each request manifest. Refresh only at a model-request boundary.
This preserves request auditability without requiring a person to update many sessions manually.
A later explicit frozen-revision mode can support workflows that need it.

An edit must not alter an already dispatched request.
A deleted or unauthorized note must stop appearing in future attachment blocks.
Do not silently truncate a note or evict another pin when the model budget changes.

### 5.3 Revocation is not erasure

Section 6.7 correctly warns about provider copies, but its future-context exclusion contract is much larger than note deletion.
Removing a managed tool result does not remove a paraphrase in an assistant reply or a compaction summary.
Exact exclusion requires source tracking through those derived records, or a clean context rebuild.
A text-matching filter cannot provide that guarantee.

Version 1 must promise removal from search and future attachment blocks, not complete removal of previously learned information.
Historical reads remain conversation data under its existing access policy.
Do not offer “exclude from future model context” until implementation can meet its stated scope.

An audience change must not expose a transcript that already contains private note text.
The system must refuse unsafe audience expansion or require a clean conversation/context with reviewed content.
Checks on new note reads alone do not solve that problem.

### 5.4 Environment memory needs structure, but not a graph

Sections 6.13 and 13 are important additions. Environment facts do not belong in `AGENTS.md`.
Separate stable machine roles and folder purposes from volatile service observations.
Each volatile record needs an observation time, host identifier, verification command, and an explicit stale-state warning.

The draft machine note is too broad to load for a single port question.
Use small topic notes, such as host/folders, inference service, and terminal service.
Search must find local listening ports and public proxy ports without confusing their roles.
Before use or sharing, resolve current public endpoints through service discovery or `tailscale serve status`.
Do not turn an archived URL into a guessed current URL.

### 5.5 Migration needs a decision about lost first-action recall

The current system automatically loads approved project and everywhere lessons before every request.
It limits lessons to 300 characters, 40 per project, and 30 everywhere.
Pia receives only everywhere lessons. Agent changes require owner approval.

Search-first retrieval removes that automatic first-action coverage.
A rule such as the required worktree workflow can be missed before the agent searches.
The cutover must classify essential action constraints separately from optional reference knowledge.
Use existing guards or explicit operating instructions where enforcement is required.
Do not move environment inventories to `AGENTS.md` as a substitute for retrieval.

Preserve `byPi`, sources, pending proposals, project mapping, and exact stored text during migration.
The existing schema records agent authorship, but does not record a complete approver history.
Do not invent missing approval metadata or label every approved lesson human-written.

Migration pins for existing sessions are a temporary compatibility measure, not the default for new sessions.
Set a clear end to old prompt injection and old writes. Do not run 2 authoritative memory systems indefinitely.
Retain the old durable document unchanged for backup and rollback.
No upstream compatibility requirement justifies a second live memory channel.

## 6. Section 6.14: retain a narrow preflight, not a general policy engine

### 6.1 The prerequisite is justified

The owner reports that Pia forgets the model ranking now.
An optional search reminder cannot satisfy “find the ranking each time Pia picks a model.”
An internal tool lookup alone also fails: it supplies information after the caller has already selected a model.
The guidance must reach a model decision before the start or switch executes.

The proposal's non-mutating first response is therefore a useful fallback.
If the caller lacks current guidance, return the note and require a new decision.
Do not start the session and merely append a warning.
Do not approve the change automatically after returning the note.

This is a deliberate exception to optional retrieval, limited to model-choice actions.
It is not a reason to force all note searches or inject the model ranking into unrelated coding turns.

### 6.2 Simplify the contract

Bind 1 approved note ID to the owner's model-choice workflow.
Use a direct, authorized lookup, not a lexical query or a general registry of mandatory purposes.
The note must remain discoverable through ordinary search too.

Prefer 1 preparation operation that returns:

- The latest approved guidance and its revision.
- The relevant current model candidates and supported thinking levels.
- Live provider availability, and usage checks when the choice depends on limits.

If the caller reaches `session_start` or `session_model` without valid preparation, return this decision context without mutation.
Then require reconsideration and an explicit retry.
A preparation hook can avoid that extra round trip when it reliably runs before a model-choice decision.
The tool-side check must remain as the fallback.

A revision string alone is not proof that the caller received the note.
Bind the preparation receipt to the caller conversation, actor, guidance binding/revision, and decision operation.
After compaction removes the decision context, the caller must receive it again before a new choice.
Re-read the latest revision for each new decision. Do not treat a session-lifetime acknowledgment as repeated retrieval.

Recheck a changed revision at the actual mutation boundary.
A newer publication requires new decision context, not silent application to an old choice.
Successful replay is different: return the original operation receipt without creating or switching anything again.
Do not reject an already completed action because the guidance changed after it completed.

Missing or inaccessible guidance must block an agent choice clearly, without leaking private text.
Give the owner a visible repair or explicit override path.
Manual human model choices must not depend on an agent retrieval loop.
Record overrides as overrides, not as policy compliance.
A broken optional search index must not block this direct lookup.

### 6.3 Gaps in the current proposal and code

1. **Default selection:** `session_start` can omit `model`.
   `pip.ts:start` then uses `Commands.createSession`, including final-folder project defaults.
   The prepared choice must include the resolved default, not only explicit model strings.
2. **Mutation boundaries:** current Pia start creates a session, configures an explicit model separately, then sends the first message.
   “Check in the mutation transaction” does not define which of these boundaries the proposal means.
   Validate the final model/thinking choice before session/worktree creation and before the first request can run.
   Preserve durable replay behavior across these steps.
3. **Thinking normalization:** `pip.ts:setModel` delegates to `Commands.configure`.
   `commands.ts` uses `clampThinkingLevel`, which can lower a requested level.
   Validate the effective level, not just the input string.
4. **Coverage:** these 2 tools belong to Pia, not to every ordinary agent.
   Pia can also gain subagent or linked-session tools when enabled.
   Apply the rule to every enabled path where Pia chooses a model, or explicitly disable an uncovered path.
   Do not apply it to every fixed-model generation or title request.
5. **Aliases and other providers:** the OpenAI ranking does not define same-tier equivalents on another provider.
   Keep catalog identifiers and owner-approved equivalences explicit.
   Do not infer them from display names or invent a cross-provider ranking.
6. **Double policy storage:** prose plus separately editable enforcement fields can disagree.
   Version and approve any enforceable fields together, with explicit conflict handling.
   Do not use a model to extract executable restrictions from prose on every call.
   A small explicit thinking-level rule is enough initially. Defer a general policy language.
7. **Availability:** avoid sending the entire model catalog and probing every provider on every decision.
   Return relevant candidates, share fresh checks where safe, and measure latency.
   This must not allow stale capability or sign-in data to authorize a choice.

### 6.4 Preserve the owner's guidance exactly

The proposal records these owner-supplied facts:

- OpenAI order: Astra, then Sol, then Terra, then Luna.
- Astra is much stronger than Sol. Sol is stronger than Terra. Terra is much stronger than Luna.
- Astra is the strongest model.
- An Astra run can hit the usage limit at about 10% of its context.
- Use Astra only for hard work.
- Agent-started Terra or Luna sessions must explicitly use `xhigh` or `max` thinking.

Do not reduce the qualitative differences to an unqualified sorted list.
The approximate 10% warning is not a context-window limit or a substitute for live usage checks.
A reason for choosing Astra supports review. It cannot prove that the work is hard.

Section 6.14 extends the thinking rule to switches. This is sensible consistency, but it is an extension beyond the quoted start rule.
Make that extension explicit in the approved policy.
If a model supports neither required level, report the conflict. Do not silently lower it.

## 7. Smallest useful first version

Build a complete notes replacement, not the whole proposal and not an OptChat compressor.

1. Add one authoritative note store in the app's durable database. Keep the existing database as the only writable authority.
2. Reuse the approval model and a small phone-friendly editor.
   Support owner-private notes and explicitly shared notes with project relevance filters.
   Preserve legacy audiences during migration. Do not silently narrow or enlarge them.
3. Add bounded lexical search, exact load, session retention, unpin, and a list of active attachments.
   Start with exact titles, words, identifiers, and paths. Include browse when a query is unknown.
4. Let pins follow approved edits at request boundaries. Persist them independently of compaction.
   Check authorization and the selected model's context budget before dispatch.
5. Add the narrow Pia model-choice preparation/preflight before cutover.
   Publish the owner-reviewed ranking note first, so normal delegation is not blocked by an empty binding.
6. Import approved lessons without rewriting them. Import pending changes as proposals.
   Disable the old `memory` mutation tool and automatic lesson section at cutover.
   Keep ordinary transcript storage and compaction unchanged.

Defer embeddings, background note extraction, summary trees, automatic consolidation, frozen pins, arbitrary groups, and broad history-exclusion controls.
An authorized history FTS index can follow as a separate increment.

### The acceptance test that demonstrates value

Use a throwaway Pi Pocket instance with scripted-model tests and a separate small real-model evaluation.
Never test migration on the owner's live database.

Seed human-written notes for the model ranking, host/folders, and a service-port observation.
Add unrelated decoys, a pending agent correction, and a private note unavailable to a shared session.
Use the inference service's local/proxy distinction as a fixture, not a claim about its present state.

| Test                                                                              | Required result                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Start an unrelated session.                                                       | Its request contains the short retrieval policy, but no unpinned environment or ranking body.                                         |
| Ask where Pia's code lives, without mentioning memory.                            | The agent chooses search/load and returns the sourced folder fact. No `AGENTS.md` inventory is needed.                                |
| Ask for the inference service port, then use its endpoint.                        | The agent distinguishes local and proxy ports, sees the observation date, and verifies current discovery before use.                  |
| Read a note without session retention.                                            | No attachment is stored. Compaction can remove the read.                                                                              |
| Keep a note for the session; compact, restart, and change model.                  | The next request still contains the authorized note. An insufficient context budget fails visibly.                                    |
| Publish an approved edit to that note.                                            | The next request receives the new revision. It does not require manual repinning.                                                     |
| Submit a pending agent correction.                                                | Search and attachment context still use approved text. The stale-approval race fails safely.                                          |
| Let Pia start a session with a default or choose a fallback after a usage limit.  | Current guidance reaches a model decision before mutation. The trace identifies guidance revision, final model, thinking, and reason. |
| Attempt Terra/Luna with lower effective thinking.                                 | Preflight rejects the choice. Normalization cannot silently bypass the rule.                                                          |
| Change guidance between preparation and execution; then replay a completed start. | A fresh action requires new preparation. A completed action returns its original receipt without duplication.                         |
| Search/load from an unauthorized shared session.                                  | No private title, count, snippet, source, body, or pin reason leaks.                                                                  |
| Delete a pinned note or restrict its audience.                                    | Future attachment blocks exclude it. The UI does not claim historical erasure.                                                        |
| Run migration twice and inspect requests.                                         | IDs/text/proposals/audiences remain correct. No old-memory block appears beside migrated attachments.                                 |

Scripted tests prove mechanics. They cannot prove spontaneous retrieval by a real model.
Use at least 10 fresh, varied environment tasks and 10 independent Pia model choices for an initial real-model smoke test.
Require retrieval before action in all model choices, no unauthorized disclosure, and correct source-backed environment answers.
Record misses, unnecessary loads, tokens, latency, and human corrections.
This is an acceptance sample, not a statistical guarantee. Add paraphrase and multilingual cases before claiming general retrieval quality.

## 8. Costs: calls, tokens, storage, and code

These costs are incremental to ordinary task inference unless stated otherwise.
Cached input still occupies context and can consume provider quota.
Subscription billing and API-equivalent token prices are different measures.

### 8.1 Notes library

- **Background model calls:** 0 for human authoring, lexical indexing, search, load, and pin operations.
  Optional agent drafting uses task inference and human review. Do not schedule automatic extraction.
- **Foreground model steps:** search followed by load usually needs 2 tool-result continuations.
  Parallel loading or a known ID can reduce this.
  A missing model-choice preparation adds a further decision continuation, not a summarizer call.
- **Prompt tokens:** the fixed discovery policy, returned snippets, loaded bodies, and active pins.
  If the pin block contains `P` tokens over `Q` requests, it contributes about `P × Q` logical input tokens.
  Read results can also persist in the normal tool history. They are not free after the first read.
- **Storage:** note bodies and revisions, approval records, a derived lexical index, and small attachment records.
  Size follows saved knowledge and edits, not every shell result.
  Request manifests can store IDs/revisions/hashes rather than duplicate whole pin blocks.
- **Human cost:** someone must author, correct, and review notes. A library does not discover every useful fact automatically.

The complete proposal's revocation and context-filtering features could make it expensive to implement.
Its small core is not evidence that the full proposal is small.

### 8.2 OptChat and Batty

Let `N` mean projected text messages, not user turns or Durable entries.
One assistant response with several tool calls can create several projected messages.
Let `L` mean leaves whose source exceeds 512 bytes.

A complete aligned binary forest has `N - popcount(N)` internal nodes.
Its initial model-work upper bound is approximately `L + N - popcount(N)` compression jobs.
Short sources and short merged children need no inference. Repairs and rebuilds add work.
Batty's rebuild dry run reports the looser bound `longLeaves + total - 1`.

Each job can need up to 5 completed candidates for size correction.
Transport/provider retries can add more calls; 5 is not a total retry bound.
Batty retries nonfatal failures after 10 seconds by default and uses 7 parallel builders.
An inference interrupted before its node commits can repeat after restart.

The gist adds a 16–32 KB compression view to each summary request, averaging 24 KB, plus instructions, tools, and the source.
Batty omits that context view and uses a separate source-only prompt.
This lowers request input and contamination risk, but weakens reference resolution.
A cheap model's reasoning output and repeated size corrections can still dominate the cost.

The main gist view grows from 64,000 to 128,000 bytes, averaging approximately 96,000 bytes.
For English at an illustrative 4 bytes per token, that is about 16,000–32,000 tokens, averaging 24,000.
Actual tokenization depends on language and model. These byte budgets are not safe token budgets for every model.
Instructions, tools, current input, output reserve, pins, and an active tool loop add more.

The gist reports 98.6% turn-prefix and 96.2% compression-prefix cache reads from a 3,000-message cache simulation.
These are not measurements from Batty or Pi Pocket.
Cache lifetime, pauses, model/provider switches, tool loading, and prompt changes can invalidate reuse.
A different cheap summary model cannot reuse the main model's cache merely because the prefix text matches.

**Illustrative scale, not a Batty measurement:**

- 100 requests with a 500-token note pin use about 50,000 logical pin-input tokens.
- 100 requests with a 24,000-token overview use about 2.4 million logical overview-input tokens.
- At 10,000 mostly long projected messages, the tree can require roughly 20,000 initial compression calls before corrections.
- At approximately 20,000 nodes and 512 bytes each, summary text alone occupies about 10.24 MB.

Short sources and merged nodes reduce compression calls and summary payload. Oversized accepted candidates can increase the payload.
The archive, original text projections, FTS text, document metadata, accounting, and old generations add storage.
Thus archive/tree storage is linear in history, not constant.

Batty also persists each run's rendered view in a packet and each eligible worker's view in a snapshot.
At 10,000 runs averaging 96 KB, packet view payloads alone approach 960 MB before database overhead or any storage compression.
A history design can reduce this duplication with immutable references, but must retain exact replay behavior.
Full rebuilds create new nodes. Selective repairs add the selected nodes and their ancestors.

### 8.3 What Batty actually accounts for

`src/server/memory-usage.ts` defines `batty.memory-usage` with separate incremental and rebuild totals.
`memory.ts:recordMemoryCall` appends `batty.memory-call` entries after inference.
`memory-compression.ts` records attempts, including returned errors and thrown calls.
`src/server/main.ts` exposes authenticated usage through `GET /api/memory/usage`, as described in `docs/runtime.md`.

Records include operation, generation/range, source hash, model, times, stop reason, response ID, and returned usage.
They exclude source text and provider error messages. They do not enter the memory tree or ordinary conversation usage totals.

Totals separate uncached input, cache reads/writes, output, reasoning, measured/unmeasured attempts, and API-equivalent catalog cost.
Reasoning is already included in output. Do not add it twice.
Coverage begins with instrumentation in `11f9df70fc79` on 2026-10-07.
Earlier compression and provider-internal retries without returned usage remain unknown.
Selective repairs currently count as incremental work, so the 2 totals do not isolate every maintenance category.

`memory-usage.test.ts` expects cost `0.99`, 4 incremental attempts, 3 measured attempts, and 1 unmeasured attempt.
Those figures come from a faux provider fixture. They are not Batty production spending.
No defensible dollar total is available in the inspected evidence.
A production comparison needs returned usage and current prices, plus separate subscription/quota reporting.

### 8.4 Code size

Counts below are physical source lines at the inspected revisions. They include comments and blank lines.
They exclude dependencies and do not represent effort estimates.

| Existing surface                                       | Lines | Scope                                                                                        |
| ------------------------------------------------------ | ----: | -------------------------------------------------------------------------------------------- |
| Pi Pocket current memory service, extension, and sheet | 1,447 | `src/server/memory.ts`, `src/server/extensions/memory.ts`, `web/sheets/memory.js`            |
| Pi Pocket current main memory test file                |   741 | `test/memory.test.ts`                                                                        |
| Batty memory production modules                        | 2,064 | 11 `src/server/memory*.ts` files, excluding tests and the fixture                            |
| Batty memory tests                                     | 2,771 | 16 `src/server/memory*.test.ts` files                                                        |
| Batty broader memory surface                           | 2,553 | The production modules plus policy, route, shared type, tree browser, and memory settings UI |

Both counts exclude integration embedded in runtime/app code, document registration, general UI, and other tests.
Batty's 2 MiB cache helper and its tests are also outside the broader memory count.
The counts therefore give an order of magnitude, not a complete subsystem total.

The proposed notes implementation does not exist, so an exact line count would be invented.
Its first version can reuse approval/editor behavior. Full revision, audience, and context-exclusion features will add substantial code and tests.
A hybrid costs the notes system plus history indexing and any later tree integration; it is not a free compromise.

## 9. Final decision

Adopt the searchable notes library as the complete replacement for current lesson authoring, storage use, and blanket prompt injection.
Keep human notes authoritative, agent retrieval voluntary, and session retention explicit.
Make environment facts searchable without putting them in `AGENTS.md`.
Make model guidance retrieval deterministic at Pia's model-choice boundary.

Keep the existing Durable archive and normal session compaction.
Add original-history search next if needed. Evaluate an OptChat-style map only for private Pia history after that baseline exists.

Do not port Batty's runtime wholesale. Retain its lessons about exact sources, search, stable snapshots, bounded caches, repair generations, and honest accounting.
Do not claim proven recall quality or low production cost that the available evidence does not establish.
