# Replace memory with a searchable notes library

Status: first version built on 2026-11-07 (section 0). The rest of this file is the original research and design proposal.
Research date: 2026-11-07.
Target: `/home/ttian7/Dev/pi-pocket`.

## 0. What the first version built, and what it deferred

The first version follows section 7 of `memory-review.md`, with the owner's decisions:
small notes, not a summary tree; an update of the current memory code, not a new system;
the stored data and its document kinds kept; and the approval flow kept.

**Correction from the owner.** The descriptions of OptChat in this file (section 5) and in `memory-review.md` are not accurate.
Do not use them as facts. The first version uses no OptChat idea.

### 0.1 Built

- **Storage.** Notes stay in `pocket.memory` (`MemoryDoc`). The kind, scope, and version are unchanged.
  A note is a `Lesson` record with optional new fields: `title`, `revision`, `purpose`, `modelRule`, and `proposal.title`.
  A stored lesson has none of them. It reads as revision 1, with its first line as its title. Nothing rewrites it.
- **Format.** The 1-line format and the 300-character limit are gone. A body is Markdown, 4000 characters at most.
  A title is optional, 120 characters at most. A longer one is refused with a size error, and the sheet shows the error before save.
  The old caps (40 for a project, 30 for everywhere) became 200 each.
- **Tools.** `note_search` searches approved notes that the session can find (every query word must start a word of the title or body;
  a partial fallback; an empty query lists the newest; 8 results by default, 20 at most).
  `note_load` has modes `read` (default), `session` (pin), `unpin`, and `list` (the session's pins).
  Both are replay-safe and offered from the start. The `memory` tool stays for proposals (add, update, remove, list), with a title.
- **Pins.** A new conversation document, `pocket.note-pins` (`NotePinsDoc`), stores pins by note id, with no text.
  Each request renders the latest approved text. So a pin lasts through compaction, a restart, and a model change,
  and follows approved edits. A pending proposal never reaches a pin. A forgotten note leaves the prompt at the next request.
  Limits: 10 notes, 16,000 characters, and a tenth of the model's context window. A pin over a limit is refused, with nothing pinned.
- **Prompt.** All-lesson injection is stopped. The memory section has the note count, a short instruction to search before acting,
  the pinned notes, and the proposal guide.
- **Approval.** Unchanged: agent and guest writes wait; only the owner approves; an approval must match the text and title that the owner saw.
  An older tab that sends no title can still approve when no title waits.
- **Pia's model-choice check.** The owner marks 1 approved note for everywhere as the guidance for model choices,
  with an optional rule (models that need a minimum thinking level). `session_start` and `session_model` then refuse a first call
  and return the note revision, the signed-in models and levels, the default for a start without a model, and a 1-use guidance code.
  The code holds 10 minutes and is stale after an approved edit. A start with the default model is checked.
  The rule is checked against the effective level after `clampThinkingLevel`. A worktree default that differs is checked after creation;
  a refused one blocks the first message until a switch. `session_model` keeps its result in a memo for replay.
- **Sheet.** Search, New note (title and Markdown body, with a live size count), open a note to see rendered Markdown,
  Edit, Delete (2 taps), Pin here / Unpin, Approve / Discard, and the owner's model-choice mark. Tested at desktop and mobile sizes.

### 0.2 Deferred

- Separate audiences beyond the current project / everywhere scopes, and private notes for each person.
- Description and tag fields, a revision history view, archive, restore, import, and export.
- Frozen-revision pins, a request manifest with loaded revisions, and a prompt inspector.
- Revocation beyond the next request, and exclusion from compaction input.
- Semantic or FTS index search. The first version scans the approved notes in memory.
- Approver identity. The stored records do not have it, and the first version does not invent it.
- Pia's model check for subagents and linked sessions: those paths keep the owner's existing `subagentModels` list.
- A migration choice to pin old lessons in active sessions. See 0.3.
- Retrieval tests with a real model. The tests use a scripted model.

### 0.3 Rules that must apply before the first action

Search-first can miss a rule such as the worktree workflow before the agent searches. The first version does not decide this alone.
The proposal for the owner:

1. Add a small `always` mark that only the owner can set, on at most a few short notes (for example 5 notes, 1500 characters in total).
   Marked notes go into every prompt, as pinned notes do now. Agents cannot set or propose the mark.
2. Mark only action rules that must apply before the first action: the worktree and merge workflow, "never fetch upstream",
   and the `~/.pi-pocket` and `~/Dev` placement rules. Facts and preferences stay search-only.
3. Where a rule can be enforced, prefer a guard or an `AGENTS.md` line over a note.

Until the owner decides, the agent instruction says to search notes at the start of a task, and the note tools need no loading.

## 1. Decision summary

Replace the current lesson system. Do not add another retrieval layer above its automatic prompt injection.

The proposed system has 3 separate operations:

1. Store an approved note in the library.
2. Read a note into normal conversation context.
3. Pin a note so the session receives it after compaction, restart, or model change.

The agent chooses when to search, read, and pin. These operations do not need human approval.
A person must approve an agent proposal before it changes the library.
Human-written notes are the main source. The agent must not rewrite them during background maintenance.

This design is not unique. Letta provides the closest storage-versus-context model.
Cursor provides description-based selection. Agent Skills provides progressive loading.
Several pi packages already provide search-first memory.
`pi-hermes-memory` is a particularly close pi adaptation, but its standing pins have a different scope and author rule.

Do not make model-specific stores. Selection belongs to the agent in the current session.
A model switch changes the available context budget, not the note identity or session pins.

The library holds environment facts and model-selection guidance, not only lessons.
Environment facts load on demand. They do not belong in `AGENTS.md` merely because they describe this machine.
Model choice needs a specific retrieval trigger because an agent can forget to search before choosing a model.
Pia and the tools `session_start` and `session_model` must retrieve the approved model guidance at that decision boundary.
See sections 6.13 and 6.14. Section 13 contains initial note drafts for the owner to edit.

## 2. Research method and limits

I used the `ddgs` skill for web search and page extraction.
I selected non-Google backends: Bing, DuckDuckGo, Brave, and Yahoo.
I did not use Google or a headless Google browser.
Some searches returned no results. I then used npm registry search to discover pi packages.
I read the selected package README files and the primary product documentation.
I also read the local pi documentation and the current Pi Pocket memory extension.

The findings below describe the retrieved documentation, not measured retrieval quality.
I did not install or execute any memory package. I did not compare their benchmark claims.
Product features can change. ChatGPT controls also vary by plan, region, platform, and workspace.

The source register in section 12 keeps the URLs used for these findings.
Local implementation references appear in section 10.

## 3. Existing systems

### 3.1 Claude Code: `CLAUDE.md` and auto memory

Sources: [C1], [C2].

- **Storage:** Human instructions use Markdown files at user, project, local, and managed scopes.
  Auto memory uses `~/.claude/projects/<project>/memory/`, with a `MEMORY.md` index and topic files.
  Repository worktrees share the auto memory directory. Auto memory is local to the machine.
- **Search:** The index routes the agent to topic files. The agent reads files with normal file tools.
  The documented system does not require a separate semantic note database.
- **Loading:** Instruction files at launch scope load at session start.
  Nested instructions and path-scoped rules can load when the agent accesses matching files.
  Auto memory loads the first 200 lines or 25 KB of `MEMORY.md`, whichever comes first.
  Topic files do not load at startup. The agent reads them when needed.
- **Writing:** People write instructions. Claude writes auto memory from useful corrections, preferences, project information, and references.
- **Human editing:** `/memory` lists instruction and memory locations, opens files, and controls auto memory.
  People can edit or delete the Markdown directly.

**Take:** Separate instructions from reference notes. Keep readable topic notes, clear scope, and a visible editor.
**Reject:** Automatically load a growing index into every session. Do not permit unapproved agent writes to the authoritative library.

The retrieved documentation includes newer version-specific behavior, including direct `AGENTS.md` support.
That detail is not a prerequisite for this proposal. Do not assume an older Claude Code installation has it.

### 3.2 ChatGPT memory

Sources: [H1], [H2].

- **Storage:** Saved memories are separate from chat history.
  The current documentation also describes improved memory summaries and context from other available sources.
  The public documentation does not specify the internal storage schema.
- **Search:** ChatGPT selects relevant personal context when it can improve a response.
  It does not search chat history for every response.
  Some saved-memory interfaces provide search and sorting.
- **Loading:** Relevant remembered information personalizes the response automatically.
  The public documentation does not expose an exact per-request pin manifest or context-injection contract.
- **Writing:** A person can ask ChatGPT to remember something. ChatGPT can also save useful context when that behavior is available.
- **Human editing:** Settings provide memory controls. Supported interfaces allow corrections, deletion, a memory summary, and source review.
  Some interfaces provide version history and prioritization.
  A summary can omit information that the system can reference.

Deleting a chat does not necessarily delete a saved memory.
Deleting a memory does not remove its mentions from existing chats.
Sources shown under a response do not necessarily list every factor used.

**Take:** Make source review, corrections, and deletion accessible without an agent conversation.
**Reject:** Do not use a partial summary as the only memory inspector.
Do not make deletion require a person to find several hidden copies.
Do not silently derive the main library from all conversations.

### 3.3 Cursor rules

Source: [R1].

- **Storage:** Project rules use version-controlled `.cursor/rules/*.mdc` files.
  Frontmatter includes `description`, `globs`, and `alwaysApply`.
  Cursor also supports user and team instructions and `AGENTS.md`.
- **Search:** For intelligent application, the agent uses a rule description to select relevant content.
  File patterns provide another selection mechanism. This is rule routing, not a general note-search database.
- **Loading:** The retrieved documentation names 4 modes: Always Apply, Apply Intelligently, Apply to Specific Files, and Apply Manually.
  Intelligent application lets the agent select by description. Manual application uses an `@` mention.
- **Writing:** People create rules. The agent can help draft them.
- **Human editing:** People use the rule editor or edit project files. Version control records project-rule changes.

**Take:** Give each note a useful title and description. Let the agent select content without a human approval step.
**Reject:** Do not require file globs or an always-apply setting for ordinary notes.
Do not treat every historical note as a behavioral rule.

This comparison covers documented rules. It does not assume that an older experimental Cursor memory feature remains available.

### 3.4 Letta / MemGPT

Sources: [L1], [L2], [L3], [L4].

- **Storage:** Letta persists agent state in a database.
  Memory blocks contain labeled text with descriptions and character limits.
  Archival memory stores searchable passages outside the active context.
  Conversation search is separate from archival knowledge search.
- **Search:** The agent can call `archival_memory_search` for semantic retrieval, with tags and pagination.
- **Loading:** Attached memory blocks stay in context. Blocks can attach to or detach from an agent.
  Multiple agents can share a block. Archival search returns information when the agent requests it.
- **Writing:** Agents can insert archival memories and edit writable blocks with memory tools.
  Developers can manage blocks and archival passages through the SDK.
  Blocks can be read-only to the agent.
- **Human editing:** Developers can create, update, attach, detach, and delete through the SDK and API.
  Archival passage management is not limited to the agent's insertion tool.

**Take:** Separate searchable storage from attached context. Use stable identifiers, descriptions, explicit attachment, and agent-read-only library content.
**Reject:** Do not give the agent unrestricted self-editing of authoritative human notes.
Do not share mutable context across unrelated sessions by default.
A Pi Pocket pin belongs to a conversation, not to a persistent autonomous agent identity.

### 3.5 Mem0

Sources: [M1], [M2], [M3], [M4], [M5].

- **Storage:** Mem0 stores memories with identifiers, entity scope, and metadata.
  The open-source project supports vector storage and an optional graph layer.
  The managed service and the open-source package have different capabilities and configuration.
- **Search:** Search supports semantic retrieval, metadata filters, and optional reranking.
  Current documentation also describes hybrid signals, including BM25 and entity matching.
  Callers must apply the correct user or entity scope.
- **Loading:** The application searches and inserts the returned information into its model context.
  The database operation alone is not a session-pinning contract.
- **Writing:** `add` normally extracts memories with inference.
  `infer=False` stores the supplied content without that extraction step.
- **Human editing:** Applications can expose list, update, delete, and history operations through the API.
  These APIs do not by themselves provide Pi Pocket's required approval interface.

**Take:** Use metadata filters, exact identifiers, history, and an optional semantic retrieval layer.
Preserve the original human text, like a raw-content path rather than an extraction-first path.
**Reject:** Do not use inferred facts as the default authoritative representation.
Do not require a hosted service or embeddings for basic search.
Do not present a search score as a confidence score for truth.

### 3.6 Zep / Graphiti

Sources: [Z1], [Z2], [Z3], [Z4], [Z5].

- **Storage:** Current Zep documentation describes Context Graphs with entities, fact edges, and source episodes.
  Facts retain provenance and validity times. User graphs and shared graphs have separate identities.
  Zep uses Graphiti to derive graph artifacts. Graphiti is a framework, not the complete hosted Zep product.
- **Search:** Graph search combines semantic similarity with BM25.
  Optional breadth-first search expands around graph nodes.
  Different operations retrieve facts, nodes, episodes, observations, and thread summaries.
- **Loading:** `thread.get_context()` returns a Context Block for application use.
  Applications can customize the block with templates or assemble reference context from search results.
  The documentation marks this context as untrusted model input.
- **Writing:** Applications ingest conversations, documents, text, or JSON. The service derives graph artifacts.
  Applications can also add explicit fact triplets and update nodes or edges.
- **Human editing:** SDK/API operations support manual graph updates and deletion.
  The dashboard provides graph inspection. The cited material does not establish a general Markdown note editor.

Provenance identifies a source. It does not prove that the source or the derived fact is correct.

**Take:** Preserve source links, change history, validity information, and authorization before retrieval.
**Reject:** Do not convert each human note into inferred graph facts as the canonical store.
Do not introduce a graph service before note retrieval needs one.
Do not let a later machine extraction silently override the human wording.

### 3.7 Agent Skills and lesson libraries

Sources: [S1], [S2], [S3].

- **Storage:** A skill uses a directory with `SKILL.md`, frontmatter, and optional scripts, references, and assets.
- **Search:** The agent sees the skill name and description and selects a matching skill.
  This catalog selection does not require vector search.
- **Loading:** Pi advertises metadata at startup. The agent reads full instructions only when needed.
  An explicit `/skill:name` invocation can force selection.
- **Writing:** People and package authors write skills. Agents can help draft them.
- **Human editing:** People edit the files and reload resources. Packages can distribute skills through npm or git.

**Take:** Use progressive disclosure. Keep discovery metadata separate from full content.
Allow a note to link to a procedure or skill without copying its whole body.
**Reject:** Do not turn every preference or research note into an executable skill.
Do not load a complete note catalog into the system prompt as the library grows.

## 4. Pi adaptations

These are researched examples, not recommended dependencies.
Package README claims are not a security audit or a compatibility test.

### 4.1 `pi-memory` by jayzeng

Sources: [P1], [P2], [P3].

- **Storage:** Markdown files under `~/.pi/agent/memory/` include `MEMORY.md`, `SCRATCHPAD.md`, daily logs, and deletion recovery records.
- **Search:** Optional qmd provides keyword BM25, semantic, and hybrid/reranked modes.
  Core read/write tools work without qmd. The documented search tool requires it.
- **Loading:** The default stable mode snapshots a context block at session start.
  The block includes scratchpad, daily logs, and long-term memory, within character limits.
  Explicit search remains available. Optional per-turn mode also injects top keyword matches from the current prompt.
- **Writing:** The agent can write long-term memory, logs, and scratchpad items.
  The package can create handoff and exit summaries.
- **Human editing:** People can edit the Markdown. Forget and restore operations provide recoverable deletion.

**Take:** Plain-text export, deletion recovery, optional hybrid search, and awareness of prompt-cache stability.
**Reject:** Do not inject daily logs and long-term memory into every session.
Do not add automatic exit summaries to the authoritative note library.

The README has inconsistent wording about deletion snapshot refresh versus appended correction in its configuration table.
This proposal does not depend on that detail. Inspect implementation before borrowing its cache behavior.

### 4.2 `pi-hermes-memory`

Sources: [P4], [P5].

- **Storage:** Global and project stores combine Markdown exports with a SQLite memory store.
  Session history has a separate FTS5 index.
  A user-authored `STANDING.md` file contains standing instructions.
- **Search:** `memory_search` searches saved memory. Session search retrieves past conversation content.
  The documented search uses SQLite FTS5 and supports multilingual handling, including trigram indexing.
- **Loading:** Default `policy-only` mode loads guidance about memory search, not the full memory files.
  A legacy mode restores full memory injection.
  Standing instructions still load in every session and every memory mode.
- **Writing:** The agent has memory add, replace, and remove tools.
  Background review, correction capture, and consolidation can produce memory.
  Only a person or the human command can write standing instructions.
- **Human editing:** Commands support memory inspection, replacement, removal, context preview, and standing-pin management.
  People can edit `STANDING.md` directly.

**Take:** This is the closest search-first pi example.
Reuse the distinction between retrieval policy and stored content. Provide an exact context preview and separate history search.
**Reject:** Do not let automatic review change the authoritative library.
Do not confuse its global human-only standing pins with our agent-selected session pins.

Its warning is important: search-first recall is probabilistic.
An agent can miss a prohibition before an action gives it a reason to search.
Mandatory safety controls must remain in guards or explicit instructions, not only in searchable notes.

### 4.3 `@agentmemory/pi`

Sources: [P6], [P7], [P8].

- **Storage:** The pi extension connects to a separate local AgentMemory service.
  The service stores project memories and captured sessions. It provides a live viewer.
- **Search:** Keyword search works without an API key. Optional local or remote embeddings add semantic retrieval.
  Pi exposes `memory_search` and `memory_get_lesson` for search previews followed by full-content access.
- **Loading:** Recall enters as reference data, separate from the system prompt.
  Compaction can refresh memory context. Optional configuration injects file-related memory after file operations.
- **Writing:** Pi exposes deliberate `memory_save` and also captures prompts, replies, failures, and tool results with privacy filtering.
  Queueing retries temporary delivery failures.
- **Human editing:** The service viewer supports browsing, editing, export, and forgetting.
  A status command reports health and capture delivery state.

**Take:** Search-preview followed by full-lesson access closely matches `tool_search` and `tool_load`.
Report service failures as failures, not as an empty search result.
**Reject:** Do not capture every interaction into the curated library.
Do not require another daemon for the first version.
Do not allow retrieved content to be captured again as a new independent lesson.

### 4.4 `pi-observational-memory`

Sources: [P9], [P10].

- **Storage:** Session ledger entries preserve source material, observations, and reflections.
  Dropping an observation from active memory does not delete its ledger history.
- **Search:** The `recall` tool retrieves source evidence for an observation or reflection identifier on the current branch.
  The README explicitly says this is not semantic search or a transcript browser.
- **Loading:** The extension renders observations and reflections for compaction, within token budgets.
- **Writing:** Background observer, reflector, and dropper processes create and manage machine-written memory.
- **Human editing:** Commands expose inspection and controls. The cited README does not establish a human-first note editor.

**Take:** Keep source evidence and separate active context from durable records.
**Reject:** Do not replace a human note library with repeated automatic observation and reflection.
Session compaction and curated cross-session knowledge solve different problems.

## 5. The likely meaning of “optchat”

Sources: [O1], [O2], [O3].

The strongest match is Victor Taelin's OptChat design, not an unrelated product called OpenChat.
A public repository describes itself as an unofficial implementation of his OptChat specification.
It links to his gist. The gist retrieved during this research now starts with **“UniiChat: one chat that never ends.”**
The same source uses the term OptMem for part of the memory algorithm.
This is a likely identification, not proof of the owner's intended reference.

The unofficial implementation is not Victor Taelin's code. Its README says he has not reviewed or endorsed it.
The current gist is the primary design source. The implementation README can describe an earlier revision.

- **Storage:** The design stores messages in an append-only log and summaries in a binary tree.
  The saved view references tree nodes. The original log provides exact source recovery.
- **Search:** The agent navigates the summary view with `zoom`, rather than using conventional keyword or vector search.
  A node can expand into its children, down to an original message.
- **Loading:** Each user message starts a fresh call with a bounded view of the whole history.
  The current specification grows that view from about 64 KB to 128 KB before a batch merge reduces it.
  These are UTF-8 byte limits, not token limits.
- **Writing:** People and agents produce the conversation. A background model produces summaries.
  The specification prohibits editing or deleting log lines.
- **Human editing:** A person can add corrections and edit standing `AGENTS.md` instructions.
  The design is not a mutable note-library editor.
  The unofficial implementation provides view and HTML export commands and imports earlier Claude Code sessions.

**Take:** Preserve exact sources, offer progressive expansion, and avoid unnecessary changes to stable cached context.
**Reject:** Do not make the whole chat the only knowledge representation.
Do not prohibit note deletion or correction. Do not treat the latest historical statement as automatically true.
Do not replace Pi Pocket's multiplayer conversations with 1 endless chat.
Do not adopt the unofficial implementation's no-approval shell behavior.

## 6. Replacement design

### 6.1 Separate library state from session state

A note can exist without any session loading it.
Reading or pinning must not publish a note or change its approval status.
Library scope controls discovery. Session attachment controls repeated context inclusion.

Use these library scopes:

- **Personal:** Visible only where the owner's private context is authorized.
- **Project:** Visible in authorized sessions for the repository, including its worktrees.
- **Shared:** Explicitly published to a defined group or conversation audience.

A global search scope must not mean disclosure to every person on the server.
Do not assume the current `everywhere` lessons already have private visibility.
Migration must retain their existing audience until a person changes it.

Use the existing repository identity rule where possible: the real git common directory identifies a project.
Outside git, use the canonical folder identity.
Pia can search the owner's authorized library across projects. Pia must not forward private notes into a shared session.

### 6.2 Note record and revision

Store authoritative note records through Pi Durable documents in the existing app database.
Do not make a derived FTS or vector index the source of truth.
Provide Markdown and JSON export for portability.
A later file-backed adapter can use the same identifiers and revision contract.
Do not implement 2 independently writable canonical stores.

Each note needs:

- Stable `id` and revision number.
- Human-editable title, description, Markdown body, and tags.
- Author identity and origin: human-written, agent-proposed, imported, or legacy unknown.
- Approver identity, where applicable. Approval does not convert agent authorship into human authorship.
- Scope and audience.
- Source links and optional source conversation/message identifiers.
- Creation and modification times.
- Optional validity or review date.
- Status: draft, published, archived, or deleted.

A proposal is a separate record. It names the target note and base revision for an edit or deletion.
A pending proposal must not alter the published revision.
Titles, descriptions, tags, scope, and audience are also approved content, not an unreviewed side channel.

Descriptions must state when the note helps. The human can leave one blank.
Search can use a literal body excerpt until the person approves a generated description.
Do not silently summarize or normalize the body.

Remove the old lesson-count caps and the 1-line lesson format.
Use explicit per-note and per-request size limits instead. Allow Markdown, lists, and code blocks.
The UI must show a size error before saving. It must not silently truncate.

### 6.3 Tool contract: discovery followed by loading

Use the pattern of `tool_search` and `tool_load`, not necessarily their internal implementation.
A note loads content. A tool load exposes an executable schema. Keep these operations visibly different.

Proposed tools:

| Tool           | Purpose                                                | Key inputs                                                           |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `note_search`  | Find approved, authorized notes without attaching them | query, scope, tags, limit, cursor                                    |
| `note_load`    | Read exact note content; optionally pin it             | note IDs, optional revisions, retention: `read` or `session`, reason |
| `note_context` | Inspect or change session attachments                  | action: list, pin, unpin; IDs; optional reason                       |
| `note_propose` | Request a library addition, edit, archive, or deletion | action, fields, target ID, base revision, source, reason             |

`note_search` returns IDs, revisions, titles, descriptions or bounded excerpts, authorship, scope, and approximate size.
It must not return every complete note by default.
Search results do not pin anything. Excerpts are still ordinary model context and can contain private data.
Apply authorization before ranking, counts, snippets, and pagination.

`note_load` returns the exact approved body with its ID, revision, source, and retention mode.
It can load an authorized known ID without a preceding search.
The default mode is `read`. A model can select `session` in the same call without a human confirmation.
Pinning a known note through `note_context` must also make the selected revision available to the model.

An agent can say “I read this and will use it” without creating any durable session attachment.
A pin is a separate durable choice. Do not infer it from prose.

Expose a short search/load policy in the prompt. Do not expose every note description there.
The existing tool-discovery layer can expose note tool schemas lazily, but the agent must know that note search exists.
Keep discovery reachable after compaction and when the library is empty.

### 6.4 Search behavior

Start with local lexical search over title, description, tags, and body.
Boost exact titles, identifiers, and code tokens. Support phrase queries and useful multilingual tokenization.
Include browse, scope filters, and tag filters when a person cannot remember a phrase.

Human-written notes get a modest ranking preference. Relevance still controls ordering.
An approved agent note can rank first when it directly answers the query.
Show authorship. Do not confuse approval, popularity, recency, and factual correctness.

Add optional semantic search only after lexical retrieval has a measured baseline.
Hybrid search can combine lexical and semantic candidates, with optional reranking.
The optional index must store the note ID, revision, and access scope.
A stale index must never return an obsolete or unauthorized body.
Validate results against current published records before returning them.

The agent chooses its queries and its loads.
There is no compulsory per-turn similarity injection and no approval dialog for a read or pin.
A small prompt policy can encourage a search at task start or after a topic change when previous knowledge can help.
Do not force repeated searches for the same unchanged task.

An index failure must report an error. It must not claim that the library has no matching notes.
If the optional embedding service fails, lexical search must continue.
A committed note must be searchable without waiting for an external embedding service.

### 6.5 Read retention

A read is a normal tool result. It stays only while normal context retention preserves it.
It can remain across several turns. It can disappear during compaction.
The original tool result remains in durable conversation history unless the normal history policy removes it.
A read is not automatically reloaded after restart or compaction.

The UI can show “Read in this conversation.”
It must not claim “Currently in the prompt” from a historical read event alone.
The request inspector must show whether a read survives in the actual request.

### 6.6 Session pin retention

A pin means: include this exact approved note revision in every subsequent model request for this conversation.
It survives compaction, restart, and model change. It has no automatic time expiry.
Unpinning ends repeated inclusion. It does not delete the note.

Persist an attachment containing the conversation ID, note ID, revision, pinning actor, reason, and timestamp.
Do not rely on a compaction summary to remember the attachment.
Reconstruct the active attachment set from committed session state before each request.
Attach the selected bodies in a dedicated reference-context section, not as new system authority.

Keep the order stable. Cache the rendered attachment block by its content hash, not by the current time.
A pin operation must commit before the next model request receives it.
The tool result can acknowledge attachment rather than duplicate a large body already present in the next request.

The request builder must exclude transient duplicate copies when it can identify them safely.
Do not remove unrelated quotations or alter the durable transcript to save tokens.
Correctness is more important than a cache hit.

A session pin does not guarantee obedience or make a note a policy enforcement mechanism.

### 6.7 Pin updates, deletion, and compaction

Pin exact revisions so an ordinary edit does not silently rewrite active session guidance.
When the library publishes a newer revision, show “Update available.”
The agent or human can compare it and repin without another approval step.
The edit itself has already passed the publication rule.

A deletion, audience restriction, or explicit revocation is different from an ordinary edit.
It must invalidate affected pins before the next request.
Show a short “Note unavailable” event without exposing revoked content.
Archive removes a note from default search but can retain existing authorized pins, with an archived warning.
Offer a separate “Archive and revoke pins” operation.

Human controls must distinguish:

- Unpin: stop repeated inclusion.
- Exclude from future model context: also filter system-managed read copies from future requests.
- Delete: remove the library note and revoke attachments.
- Purge history: a separate destructive operation, with a preview and the normal conversation data rules.

None of these operations can erase information already sent to a provider or remove arbitrary human quotations automatically.
Tell the person this limitation.

Compaction can discard ordinary note reads. It must not alter active attachments.
A compaction summary can name the pins, but the request builder must reattach their exact content independently.
If the summarizer sees a revoked note through old context, the summary must not reintroduce its body.
Future-context exclusion needs coverage in transcript selection and compaction input, not only in the pin renderer.

### 6.8 Context budget

“Keep for this session” is a retention promise, not infinite model capacity.
The UI must show note sizes and the pin total.
Token counts are estimates and can change with the selected model.

Set a visible session pin budget below the selected model's context limit.
Refuse an attachment that exceeds the budget. Return the required size and current pins.
Do not silently truncate a note or evict an existing pin.
The agent can unpin less useful notes or read a large note without pinning it.
A person can approve a larger budget within the actual model limit.

If a model switch makes existing pins too large, pause before the request.
Ask the agent or human to reduce pins or select a larger-context model.
Do not claim that all pins remain loaded when the provider cannot receive them.

### 6.9 Human-first authoring and approval

The main action is **Add note**, not “Ask the agent to remember.”
A person can write a title, body, description, tags, audience, and scope.
An authorized owner or curator can publish directly.
Other contributors can submit proposals according to the library permissions.

Agents can propose additions and changes. Agents cannot approve their own proposals.
A request such as “remember this” can start a proposal, but it does not bypass human review.
An explicit human save in the editor can publish the final text immediately.

Review must show the complete text, scope, audience, source, and an edit diff.
Approval must compare the reviewed proposal revision and base note revision atomically.
If either changed, require a new review. Do not approve unseen text.
A pending proposal is not searchable as approved knowledge and cannot be pinned as a published note.
People can preview it in the review screen. A preview is not publication.

Keep agent suggestions in a separate queue. Do not mix them with human drafts.
Disable automatic background extraction by default.
Do not fill the queue with a lesson after every task or force people to approve routine summaries.
A proposal should preserve a useful discovery that the existing library does not cover.

### 6.10 Human interface

Provide 2 connected views:

**Notes library**

- Search and browse without an agent turn.
- Filter by project, audience, tag, status, and authorship.
- Add, edit, duplicate, archive, delete, restore, import, and export.
- Show revision history, sources, and sessions with active pins, subject to access permissions.
- Show agent proposals in a separate review tab.

**This session**

- Show active pins, exact revisions, actor, reason, and token estimate.
- Show an update indicator when a newer revision exists.
- Provide pin, unpin, replace revision, and exclude-from-future-context controls.
- Show a separate read-history list. Label it as history, not a live prompt manifest.
- Provide “What the next request will load” and a request-time record of what actually loaded.

A concise activity line can say “Read 2 notes” or “Pinned deployment checklist for this session.”
Do not interrupt the conversation with a modal for these actions.
A person can change pins directly. Session steering permissions apply to shared-session pin changes.

On a phone, use a searchable list and a full-height editor with a stable Save action.
Keep scope and audience visible before publication. Keep destructive actions separate from Unpin.

### 6.11 Multiplayer and safety

The current session audience determines the maximum information that its model context can receive.
An agent acting for the owner must not load a private note into a shared conversation just because the owner can read it.
The same rule applies to titles, snippets, counts, provenance links, and pin reasons.

Do not expose private source conversation names to someone who cannot see them.
Use an unavailable-source label when the note itself has an authorized shared copy.
Sharing a note must be an explicit publication action, not a side effect of pinning it.

Treat external quotations and imported material as reference data.
Approval does not promote a note above system rules or make embedded instructions safe.
Never execute a tool because a retrieved note tells the agent to ignore approval rules.
Guards enforce dangerous-action policy independently of memory.

A human-written note can be stale or wrong. Preserve its authorship without asserting that it is verified.
When evidence conflicts, the agent must explain the conflict or propose a correction.
It must not silently overwrite the note.

### 6.12 Branches, subagents, and new contexts

Session pins belong to a durable conversation, not to a provider context window.
“New context” within that conversation retains pins. Compaction also retains them.
A new conversation starts without pins unless the person explicitly uses an inheritance option.

A branch copies the authorized attachment set at its branch point.
Later changes in either branch do not change the other branch's attachment set.
Library revocations still apply to both.

Subagents receive only notes that their task and audience authorize.
Do not copy the whole parent library or every parent pin automatically.
The parent can pass selected authorized notes or let the subagent search.
A subagent cannot modify the parent's pins without an explicit parent operation.

### 6.13 Environment facts are first-class notes

The library must hold facts, reference information, inventories, preferences, and procedures, as well as lessons.
A note does not need to describe a mistake or a discovery to qualify.

Environment notes can describe:

- The machine identity and role. This machine is the harness host.
- Important folders and what each folder holds.
- Services, local listening ports, and discovered public endpoints.
- The observation time, verification command, and conditions that can make a fact stale.

Store a machine identifier in searchable metadata. Tags can include `environment`, `machine`, `folders`, `services`, and `ports`.
A machine is a retrieval filter, not a replacement for audience permissions.
A private infrastructure inventory must not leak into an unauthorized shared session.

Search must support questions such as “Which machine runs this harness?” and “Where is Pia's code?”
It must also support “Which port serves the inference gateway?”
The agent can read the relevant note once or pin it for ongoing infrastructure work.
Unrelated sessions receive neither the inventory nor its full catalog.
Do not copy these facts into `AGENTS.md` to compensate for weak retrieval.

Separate stable roles and folder purposes from volatile listener observations when the library grows.
Store service observations with a timestamp. A note about an observed port is not a promise that the service remains available.
Before using or sharing an endpoint, verify current service discovery.
Use `tailscale serve status` or the app's service discovery to resolve tailnet HTTPS links.
Do not construct a public URL from a remembered hostname or a raw loopback address.

A verification result does not silently edit the published note.
An agent can report a mismatch and propose a revision. A person must approve that revision.

### 6.14 Retrieve model guidance at the model-choice boundary

The library must hold the owner's model ranking and operating rules.
The ranking is owner-supplied guidance, not a measured benchmark or a vendor capability guarantee.
Keep the exact qualitative differences. Do not reduce “much stronger” to the same relation as “stronger.”

The owner supplied these facts and rules:

- The OpenAI order is Astra, then Sol, then Terra, then Luna.
- Astra is much stronger than Sol.
- Sol is stronger than Terra.
- Terra is much stronger than Luna.
- Astra is the strongest model.
- A run with Astra can hit the usage limit at about 10% of its context.
- Use Astra only for hard work.
- When an agent starts a session with Terra or Luna, it must set the thinking level to `xhigh` or `max`.

Pia and agents must use this guidance when they choose a model.
Ordinary search-first recall is not sufficient here. Pia currently forgets these facts too often.
Use an action-specific discovery and load step, not universal note injection.

**Discovery and binding**

An authorized person can bind a published note to the purpose `model-selection`.
The binding is an explicit configuration record with audience and scope checks.
It is not an agent-generated tag that can make arbitrary notes mandatory.
`note_search` must support this purpose as a deterministic filter, as well as normal text queries.
The purpose binding identifies the note. The approved note remains the source for its ranking and rules.

Pia's model-selection workflow must search this purpose and load the latest approved revision before it chooses a model.
The search and load do not require human approval. The agent can read or pin the note.
The tool descriptions for `session_start` and `session_model` must state this prerequisite.
Selecting a default model also counts as choosing a model.

**Tool preflight**

`session_start` and `session_model` must resolve the binding before they create or change a session.
They must not depend only on the caller remembering to search.
They must use the same authorized discovery and load service as the note tools.
This check applies to Pia, other agents, retries, fallback choices, and choices after a usage-limit failure.

If the caller has not loaded the current approved revision, preflight must return it as decision context before execution.
The tool must not start or switch a session in that call.
The caller must reconsider the choice and retry with the loaded revision identifier.
This is an agent continuation, not a human approval dialog.
The preflight must also show the current model catalog and relevant live usage or capability checks.
Do not make the caller use stale aliases or infer a model identifier from the note's display names.

If no authorized published guidance exists, report that the guidance is unavailable.
Do not disclose a private note to satisfy this requirement.
Do not silently use an inaccessible note or claim that the ranking was checked.
The owner can publish an authorized copy or configure an explicit, visible exception.

A stale pinned revision must not satisfy a check for the latest model-selection guidance.
Preflight loads the current revision for the decision. It does not silently replace unrelated session pins.
Approval of a newer note revision invalidates earlier model-choice acknowledgments.
Check the revision again in the mutation transaction to prevent a concurrent edit from bypassing review.

**Applying the rules**

Record the guidance revision, resolved model identifier, thinking level, and a short selection reason in the model-choice activity.
The caller must explain why work is hard when it chooses Astra.
“Hard work” requires agent judgment. A tool must not claim that a label proves task difficulty.
The approximate 10% usage warning is not a fixed context limit and must not replace live provider usage checks.

The tool must reject an agent-started Terra or Luna session unless the thinking level is explicitly `xhigh` or `max`.
Apply the same minimum-setting validation when `session_model` moves an agent's session to Terra or Luna.
This prevents a switch from carrying an unsuitable lower setting into the new model.
Resolve supported thinking levels from the current model catalog.
If neither required level is supported, report the conflict. Do not silently use a lower level.
A human override must be explicit and recorded. It must not masquerade as compliance with the owner's rule.

Keep enforceable model-choice fields beside the prose in the same approved note revision.
For example, the revision can contain model aliases, required thinking levels, and the Astra hard-work restriction.
The review UI must show these fields. The tool must not execute hidden fields that the person did not approve.
The model catalog resolves aliases to actual provider IDs. It does not rewrite the owner's relative ranking.

This is a narrow, action-specific loading contract.
It does not force model-ranking content into every coding request or make all note retrieval mandatory.
Once loaded, the agent can retain the guidance as an ordinary read or a session pin.

## 7. Example lifecycle

1. A person writes “Production deployment checks” and publishes it for the project.
2. A coding session starts. Its prompt contains the note-search policy, but not this note.
3. The agent searches for deployment checks.
4. Search returns the note ID, revision, description, authorship, and size.
5. The agent loads it with `retention: read` and uses it for the current explanation.
6. The task changes to a deployment. The agent pins that revision with a reason.
7. Compaction occurs. The normal read can disappear. The pinned body still reaches the next request.
8. A person corrects the library note. The session shows an update, but retains its current revision.
9. The agent reads the diff and selects the new revision.
10. The agent unpins it after deployment. The library note remains available to later searches.

No human approval is required for steps 3 through 6 or step 9.
An agent-authored library correction would require a separate approval before step 8 could publish it.

## 8. Migration from the current memory system

### 8.1 Existing behavior

The current system stores lessons in the durable `pocket.memory` document.
Approved project and everywhere lessons enter the memory prompt section before each request.
Pia receives everywhere lessons. Pending content does not enter that section.
Project identity uses the git common directory or the folder outside git.
The current UI already supports direct human additions, editing, forgetting, and pending review.
Its old caps are 40 project lessons and 30 everywhere lessons.

This replacement removes blanket lesson injection and the old authoring tool.
It must not leave a second always-loaded memory channel running beside note search.

### 8.2 Preparation

1. Export approved lessons, pending additions, edit/delete proposals, IDs, scopes, authorship, timestamps, and provenance.
2. Record a checksum and counts by status and scope.
3. Show the owner a migration preview. Do not rewrite live data by hand.
4. Explain that search-only notes can no longer guarantee first-action recall of existing prohibitions.

Use a versioned, idempotent app migration through Pi Durable.
Do not rename the persisted `pocket.memory` document or change its old schema meaning.
Create new documents beside it and retain the old document as a read-only migration source.
This respects stored-data compatibility even though the product design does not need to follow upstream.

### 8.3 Conversion

- Convert each approved lesson into 1 published note. Preserve its exact text as the body.
- Preserve its ID through a mapping, original scope, audience, author, approval status, and source links.
- Use a literal first-line title as a fallback. Do not let a migration model rewrite the body.
- Mark authorship unknown when the old data does not establish it. Do not label every approved lesson as human-written.
- Convert pending additions into pending note proposals, not published notes.
- Convert pending edits and deletions against the mapped published revision. Keep the published body unchanged.
- Do not merge similar notes automatically. Offer an optional human-reviewed cleanup later.
- Preserve old identifiers in transcript links so earlier approval and activity lines remain understandable.

Everywhere lessons become broadly discoverable notes with their existing audience.
A person can later narrow them to personal scope. Migration must not silently change visibility or enlarge it.

### 8.4 Existing sessions and mandatory instructions

At cutover, offer an explicit migration choice for active sessions:

- **Recommended compatibility option:** Create session pins for the approved lessons that session currently receives.
  Mark them “Migration pin.” New sessions still start search-first.
- **Clean transition option:** Create no pins. The next request receives only the retrieval policy.

Require the owner's selection before cutover. Do not silently choose either behavior.
Check the selected model's pin budget. Report an over-budget session instead of dropping content.
Do not auto-pin every library note in every future session.

Show existing prohibitions and universal workflow rules in a separate review list.
A person can move essential instructions into the appropriate `AGENTS.md` or guard configuration.
Do not automatically edit instruction files or create a new hidden always-on memory category.
Leaving such an item only in the library accepts the risk of a missed search.

### 8.5 Cutover, validation, and rollback

Make the new library and session attachments available before removing old injection.
Then switch authoring tools, prompt sections, UI routes, and proposal review together under a versioned feature state.
Prevent old clients from continuing to publish into a retired writable store.
Preserve historical old-tool rendering. Do not replay an old mutation into the new system without an idempotent mapping.

After validation, disable the old memory tool and prompt renderer.
A request must never contain both the old lesson block and its migrated pin copies.

Validate counts, text checksums, scope, audience, proposal state, and source links.
Do not delete the old document as part of cutover.
Keep rollback data and the migration report under the normal backup policy.
A rollback must first stop new writes. It must export or reconcile post-cutover changes explicitly.
Do not replay both old and new queues or discard newer notes silently.

## 9. What to build first

### Phase 1: authoritative notes and manual control

- Add versioned notes, proposals, access rules, and revision history.
- Add the human editor and migration preview.
- Add local lexical search and `note_search` / `note_load`.
- Remove no old behavior until the cutover is approved.

### Phase 2: durable session retention and replacement

- Add pin state, request assembly, compaction retention, and context inspection.
- Add revocation, audience-change handling, and model-budget checks.
- Add model-selection purpose binding and preflight for Pia, `session_start`, and `session_model`.
- Review and publish the initial model-ranking note before enforcing its retrieval prerequisite.
- Add environment-fact retrieval tests without automatic inventory injection.
- Migrate approved data and pending proposals.
- Switch off old injection and old mutation tools at cutover.

### Phase 3: measured retrieval improvements

- Evaluate search misses and unnecessary loads with human-selected tasks.
- Add semantic search only when it improves measured retrieval.
- Add optional note-to-skill export and richer source expansion later.
- Keep automatic authoring outside the default design.

## 10. Pi Pocket integration findings

Local sources inspected:

- `/home/ttian7/Dev/pi-pocket/docs/index.md`
- `/home/ttian7/Dev/pi-pocket/docs/features.md`, Memory section
- `/home/ttian7/Dev/pi-pocket/docs/architecture.md`, Memory section
- `/home/ttian7/Dev/pi-pocket/docs/map.md`, memory and extension entries
- `/home/ttian7/Dev/pi-pocket/docs/self-editing.md`
- `/home/ttian7/Dev/pi-pocket/AGENTS.md`
- `/home/ttian7/Dev/pi-pocket/src/server/extensions/memory.ts`
- `/home/ttian7/Dev/pi-pocket/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
- `/home/ttian7/Dev/pi-pocket/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `/home/ttian7/Dev/pi-pocket/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, integration and context sections

Current change surfaces identified by those references:

- `src/server/memory.ts`: scope, authorization, approval, and current lesson service.
- `src/server/extensions/memory.ts`: current tool and automatic prompt section.
- `src/server/docs.ts`: persisted document definitions.
- `web/sheets/memory.js`: current memory UI.
- Memory HTTP handlers, host interfaces, inline tool rendering, menu commands, and Pia's pending queue also need replacement integration.
- Existing memory tests must continue to cover approval races and unauthorized cross-project access during migration.

The local pi docs support model-callable tools, request-context transformation, and durable non-context entries.
They describe `before_agent_start`, `context`, `context_with_system`, and `pi.appendEntry()` for native pi extensions.
These are capability references, not direct instructions to insert pi CLI hooks into Pi Pocket.
Pi Pocket currently uses Pi Durable `defineExtension`, `defineTool`, and `section` with `host.memory`.
Use the durable app's document and request assembly interfaces for the actual replacement.
Confirm the exact types and ordering during implementation.

## 11. Acceptance tests and open implementation choices

The product decisions in this proposal are settled for this draft.
No further human approval is needed for individual note reads or session pins.
The following technical choices need implementation validation, not a new product direction:

- Exact new document kinds and transaction boundaries.
- Lexical tokenizer and index deployment supported by the app's SQLite layer.
- Default per-note size limit and session pin budget.
- Context filtering needed for exclusion and revocation across compaction.
- Optional semantic provider, if later evaluation supports one.

Required tests:

1. A new session gets the search policy but no complete unpinned notes.
2. Search returns authorized metadata only. It cannot leak counts or snippets across audiences.
3. Load returns the requested approved revision. Pending proposals cannot pass as approved content.
4. Read mode creates no pin. Compaction can remove the read without removing the note.
5. Session mode persists through restart, compaction, and model change without depending on summary text.
6. A library edit reports an update without silently replacing the pinned revision.
7. Revocation, deletion, and audience restriction remove affected attachments before the next request.
8. Future-context exclusion also filters managed historical reads and compaction input.
9. Human publication and agent proposals remain distinct. Stale approval and stale edit revisions fail safely.
10. Concurrent pin/unpin operations have a deterministic committed result. Replayed tool calls do not duplicate state.
11. An over-budget load fails without partial attachment. A smaller model cannot silently drop pins.
12. Branch pins diverge correctly. Revocations reach both branches. Subagents do not inherit private content accidentally.
13. Search failure differs from zero results. Lexical search still works without embeddings.
14. Human-written content remains byte-preserved through import and export, except explicitly documented encoding normalization.
15. Migration preserves IDs or mappings, exact text, status, source, and audience. Re-running migration does not duplicate notes.
16. Cutover produces no duplicate old-memory and pin blocks. Rollback does not lose post-cutover edits.
17. The mobile UI supports authoring, complete proposal review, unpin, delete, and an exact next-request preview.
18. The prompt inspector reports actual loaded revisions and size estimates for the selected model.
19. Environment searches retrieve machine roles, folder purposes, and service ports without loading the inventory into unrelated sessions.
20. Volatile environment facts show observation times. Endpoint use verifies current discovery instead of treating a saved URL as permanent.
21. Pia retrieves the approved model-selection note before choosing a model, including defaults and usage-limit fallbacks.
22. `session_start` and `session_model` cannot execute an agent choice before current guidance reaches the caller.
23. A stale model-guidance pin or a concurrent revision change cannot satisfy model-choice preflight.
24. Terra and Luna starts require explicit `xhigh` or `max`. Switches validate the same requirement and fail on unsupported capabilities.
25. The Astra reason, qualitative ranking differences, and approximate 10% usage warning remain visible during model choice.
26. Missing or unauthorized model guidance produces a clear error or an explicit authorized exception, not a private-note leak.

Retrieval evaluation must include exact code terms, paraphrases, multilingual notes, stale notes, conflicting notes, and unrelated decoys.
Measure relevant-note recall, unnecessary loads, pin growth, request tokens, latency, and human correction effort.
Do not use note count or agent-written lesson count as a success metric.

## 12. Source register

### Claude Code

- [C1] https://code.claude.com/docs/en/memory
- [C2] https://code.claude.com/docs/en/skills

### ChatGPT

- [H1] https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- [H2] https://openai.com/index/memory-and-new-controls-for-chatgpt/

### Cursor

- [R1] https://cursor.com/docs/rules

### Letta / MemGPT

- [L1] https://docs.letta.com/guides/agents/memory/
- [L2] https://docs.letta.com/v1-sdk/memory/memory-blocks/
- [L3] https://docs.letta.com/v1-sdk/memory/archival-memory/
- [L4] https://docs.letta.com/api/resources/agents/subresources/passages/methods/search

### Mem0

- [M1] https://github.com/mem0ai/mem0
- [M2] https://docs.mem0.ai/core-concepts/memory-operations/search
- [M3] https://docs.mem0.ai/api-reference/memory/search-memories
- [M4] https://docs.mem0.ai/core-concepts/memory-operations/add
- [M5] https://docs.mem0.ai/core-concepts/memory-operations/update

### Zep / Graphiti

- [Z1] https://help.getzep.com/graph-overview
- [Z2] https://help.getzep.com/searching-the-graph
- [Z3] https://help.getzep.com/retrieving-context
- [Z4] https://help.getzep.com/adding-fact-triplets
- [Z5] https://github.com/getzep/graphiti

### Skills and pi interfaces

- [S1] https://agentskills.io/specification
- [S2] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
- [S3] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- [S4] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- [S5] https://pi.dev/packages

The installed local docs were the authority for pi interface findings.
The GitHub links identify the corresponding public documentation, which can change independently of the installed version.

### Pi memory packages

- [P1] https://github.com/jayzeng/pi-memory
- [P2] https://www.npmjs.com/package/pi-memory
- [P3] https://github.com/tobi/qmd
- [P4] https://github.com/chandra447/pi-hermes-memory
- [P5] https://www.npmjs.com/package/pi-hermes-memory
- [P6] https://github.com/rohitg00/agentmemory/tree/main/integrations/pi
- [P7] https://github.com/rohitg00/agentmemory
- [P8] https://www.npmjs.com/package/@agentmemory/pi
- [P9] https://github.com/elpapi42/pi-observational-memory/tree/master
- [P10] https://www.npmjs.com/package/pi-observational-memory

Primary package documents retrieved:

- https://raw.githubusercontent.com/jayzeng/pi-memory/main/README.md
- https://raw.githubusercontent.com/chandra447/pi-hermes-memory/main/README.md
- https://raw.githubusercontent.com/rohitg00/agentmemory/main/integrations/pi/README.md
- https://raw.githubusercontent.com/rohitg00/agentmemory/main/README.md
- https://raw.githubusercontent.com/elpapi42/pi-observational-memory/master/README.md

### OptChat / UniiChat

- [O1] https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449
- [O2] https://github.com/maozedong/opchat-vibe
- [O3] https://github.com/maozedong/opchat-vibe/blob/dev/docs/how-optchat-works.html
- Primary specification retrieved: https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw
- Implementation README retrieved: https://raw.githubusercontent.com/maozedong/opchat-vibe/dev/README.md

### Discovery endpoints

- https://registry.npmjs.org/-/v1/search?text=pi-coding-agent%20memory&size=15
- https://registry.npmjs.org/-/v1/search?text=pi-package%20memory&size=15

### Verification status

The principal memory pages, selected package READMEs, Agent Skills specification, and OptChat gist were retrieved and inspected.
Some secondary links came from search results or primary-page references, rather than a separate full-page retrieval.
These include [C2], [H2], [L4], [M1], [Z5], [P3], and [O3].
They are supporting references, not independent evidence for an unverified implementation claim.
No package compatibility, retrieval benchmark, or security guarantee is asserted by this research.

## 13. First notes after migration

Create these as separate notes or small linked groups. Do not publish the drafts below automatically.

1. **Owner's model ranking and selection rules.** Review this first and bind its approved revision to `model-selection`.
2. **Harness host identity and important folders.** Use machine metadata so agents can distinguish this host from remote machines.
3. **Harness host services and ports.** Record observed listeners, discovered endpoints, verification commands, and observation times.
4. **Additional environment facts from migrated lessons.** Keep their original text and provenance until the owner edits them.
5. **Pi Pocket user interface verification.** Check each fix in a new temporary server from the changed worktree and report screenshot paths.

The 3 drafts below are **draft, for the owner to edit**.
They are proposal text, not published notes. Their contents are not currently bound to a tool or loaded into other sessions.

### 13.1 Model-ranking note draft

**Status:** draft, for the owner to edit.
**Title:** Owner's model ranking and model-selection rules.
**Description:** Read before Pia or an agent chooses a model, starts a session, switches a model, or selects a fallback.
**Suggested tags:** `models`, `ranking`, `thinking`, `usage`, `model-selection`.
**Suggested purpose:** `model-selection`, after owner approval.
**Audience:** The owner must select an audience that covers the intended Pia and agent model-choice workflows.
**Source:** The owner's requirements, relayed by Pia in this conversation on 2026-11-07.

Draft body:

> The OpenAI model order is Astra, then Sol, then Terra, then Luna.
>
> Astra is much stronger than Sol. Sol is stronger than Terra. Terra is much stronger than Luna.
>
> Astra is the strongest model. A run with Astra can hit the usage limit at about 10% of its context.
> Use Astra only for hard work.
>
> When an agent starts a session with Terra or Luna, it must set the thinking level to `xhigh` or `max`.
>
> Pia and agents must use these facts when they choose a model.
> The tools `session_start` and `session_model` must retrieve this guidance before they execute an agent's model choice.
> Resolve Astra, Sol, Terra, and Luna against the current model catalog. Do not guess their provider identifiers.
> Check live provider usage separately. The approximate 10% warning is not a fixed context-capacity measurement.

Draft enforceable fields, for the same owner review:

| Field                   | Draft value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Purpose                 | `model-selection`                                                                    |
| OpenAI order            | Astra > Sol > Terra > Luna                                                           |
| Qualitative differences | Astra much stronger than Sol; Sol stronger than Terra; Terra much stronger than Luna |
| Strongest model         | Astra                                                                                |
| Astra eligibility       | Hard work only; record the selection reason                                          |
| Astra usage warning     | A run can hit the usage limit at about 10% of its context                            |
| Terra agent start       | Explicit thinking level `xhigh` or `max`                                             |
| Luna agent start        | Explicit thinking level `xhigh` or `max`                                             |
| Switch validation       | Apply the same thinking requirement when `session_model` selects Terra or Luna       |
| Provider IDs            | Resolve through the live catalog; not supplied by this draft                         |

### 13.2 Machine note draft

**Status:** draft, for the owner to edit.
**Title:** Harness host `ttian7-of01`: identity, folders, and service observations.
**Description:** Read when a task needs this host's role, important paths, local services, or port discovery.
**Suggested tags:** `environment`, `machine`, `ttian7-of01`, `harness`, `folders`, `services`, `ports`.
**Suggested audience:** Owner-private infrastructure reference, unless the owner explicitly shares it.
**Observed at:** 2026-11-07, approximately 15:15, UTC-06:00.
**Sources:** Owner statements, including the service-port correction relayed by Pia, local Pia documentation, and the read-only commands listed below.

Draft body:

> This machine is the harness host. Its hostname is `ttian7-of01`.
> At observation time, it ran Linux `7.0.0-38-generic` on `x86_64`.
>
> Important folders:
>
> | Folder                              | Purpose and evidence                                                                                   |
> | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
> | `/home/ttian7/Dev`                  | Project working area and this conversation's working directory                                         |
> | `/home/ttian7/Dev/pi-pocket`        | Pia's code and documentation; documented by `docs/index.md`                                            |
> | `/home/ttian7/.pi-pocket`           | Pia's default harness data: settings, session database, and related app data; not a project workspace  |
> | `/home/ttian7/.pi/agent`            | Agent resources, settings, and sessions; documented by `docs/index.md`                                 |
> | `/home/ttian7/Dev/marimo-pair`      | Local marimo pairing project; contains the configured `marimo-pair` skill                              |
> | `/home/ttian7/Dev/marimo-skills`    | Local marimo skill collection; contains the configured notebook skills                                 |
> | `/home/ttian7/Dev/ink-board`        | Working directory of the observed Node listener on local port `8375`                                   |
> | `/home/ttian7/Dev/inference-router` | Working directory of `inference-gateway.service` and the observed Python listener on local port `8095` |
>
> Service observations:
>
> | Service or observed process    | Local listening ports                                                        | Discovery and verification                                                                                                                                                                   |
> | ------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Ink-board project Node process | `127.0.0.1:8375`                                                             | The process working directory was `/home/ttian7/Dev/ink-board`; Tailscale HTTPS port `8376` proxied this listener                                                                            |
> | `inference-gateway.service`    | `127.0.0.1:8095`                                                             | The service description was “On-demand inference gateway (llama.cpp / Strata)”; Tailscale HTTPS port `8443` proxied this listener                                                            |
> | `emacs-web.service`            | `127.0.0.1:7681`                                                             | The service description identified Emacs in the browser with Wetty; Tailscale HTTPS port `9450` proxied this listener                                                                        |
> | `jupyterlab.service`           | `127.0.0.1:8888`, `0.0.0.0:8787`, and wildcard port `33243` on IPv4 and IPv6 | The listeners belonged to the service's `jupyter-server` process; do not infer each listener's function from its port                                                                        |
> | Marimo processes               | `127.0.0.1:28374`, `28375`, `28376`, and `28377`                             | Their working directory was `/home/ttian7/Dev/tiangroup-uofa/mate374-cmpt-methods-mate`; these are session observations, not fixed assignments                                               |
> | `pi-pocket-office.service`     | `127.0.0.1:18787`                                                            | Its start command has `--port 18787`, as corrected by the owner through Pia. The observed service description was “Pi Pocket office (loopback only)”; verify its current endpoint before use |
>
> Selected tailnet URLs resolved by `tailscale serve status` at observation time:
>
> - Ink-board project listener: https://ttian7-of01.iguana-torino.ts.net:8376
> - Inference gateway listener: https://ttian7-of01.iguana-torino.ts.net:8443
> - Emacs browser service: https://ttian7-of01.iguana-torino.ts.net:9450
>
> These URLs are tailnet-only. Resolve them again before sharing or using them.
> This note is not a complete service inventory. A listening port does not establish the service's purpose or health.
> Service assignments, running processes, and ports can change. Use current discovery instead of assuming this snapshot is permanent.
> Load this note only when the task needs environment facts. Do not put this inventory into `AGENTS.md`.

Read-only evidence collected for this draft:

- `hostname` and `uname -srm`.
- Directory existence checks for the listed projects and resource folders.
- `ss -lntp` for TCP listeners and visible process identifiers.
- `readlink /proc/<pid>/cwd` for selected listener working directories.
- `systemctl --user list-units --type=service --state=running` for active service names and descriptions.
- `systemctl --user show` with only `Id`, `MainPID`, and `WorkingDirectory` for selected services.
- `tailscale serve status` for current proxy mappings and tailnet HTTPS URLs.
- `/home/ttian7/Dev/pi-pocket/docs/index.md` for code, agent-resource, and harness-data folder purposes.

No credentials, service environment variables, or private configuration contents were read for this draft.
The office-service port and start-command correction came from the owner through Pia, not an additional local command inspection.

### 13.3 Pi Pocket user interface verification note draft

**Status:** draft, for the owner to edit.
**Title:** Check Pi Pocket user interface fixes in a new temporary server.
**Description:** Read before an agent fixes or verifies Pi Pocket's user interface, and before it reports or merges the fix.
**Suggested tags:** `pi-pocket`, `ui`, `verification`, `worktree`, `browser`, `screenshots`.
**Suggested scope:** Pi Pocket project, including its worktrees.
**Source:** The owner's rule and incident report, relayed by Pia in this conversation; `docs/self-editing.md` describes the temporary server.

Draft body:

> When an agent fixes the user interface in Pi Pocket, it must start a new temporary server from its own local copy.
> Then it must check the fix in that server.
>
> 1. Run `node test/serve.ts` from the worktree with the change, not from `main`.
>    This command starts a throwaway copy of the server. `docs/self-editing.md` describes the procedure.
> 2. Open the temporary server in the browser tool.
>    Check the fix and take screenshots at both the `desktop` viewport and the `mobile` viewport.
> 3. Save the screenshots as files. Give their file paths in the verification report.
>    A statement that the browser check passed does not replace the screenshot files and paths.
> 4. Stop the temporary server when the check is done.
>
> The running owner server needs a sign-in. The headless browser cannot sign in to it.
> Use the temporary server instead. A sign-in problem on the owner server must not cause the agent to skip the visual check.
>
> The owner reported that a fix was merged without a visual check for this reason on the day of this request.
> This rule prevents that failure from recurring.

This is a draft library note, not a new code change or a claim that this session ran a browser check.
