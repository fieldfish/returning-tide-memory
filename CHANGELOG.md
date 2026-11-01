# Changes

## 0.3.11

- Resolve the active official tool provider in global and standard desktop preset scopes. Match the actual registration, executor, parameter schema and call evidence before certifying a no-effect refusal.
- Settle native unread edits when the matching filesystem intent was rejected. Settle invalid official PowerShell arguments when the host validator independently rejects that call and the tool reports its native validation error.
- Treat official web fetch as a read and add a provider registration API for side-effect-free third-party queries or specific read modes. Recheck a declared mode at the provider boundary. Preserve the recovery hold for partial writes, uncertain timeouts and undeclared tools.
- Keep verified reads available during review. Record the basis for each classification and clarify the bilingual manager's recovery scope and unverified stages.

## 0.3.10

- Add a persistent lexical candidate index using Chinese character pairs and ASCII pair/four-character windows. Verify candidates against current full text before applying the existing hybrid ranking and evidence filters.
- Maintain sources incrementally in cancellable idle batches. Pending and oversized sources remain candidates, preserving long-message tail matches during backfill. Updates, deletion, activity payload changes and restart retain a searchable path.
- Join lexical maintenance to the existing lifecycle queue so unload waits for it. Avoid unnecessary vector maintenance on empty libraries and fix the foreground-cancellation regression fixture to create real pending work.
- Add a reproducible 0.3.9 versus current benchmark on 10,000 and 50,000 synthetic sources with 1,024-dimensional precomputed vectors. Publish latency, process RSS, index growth, build costs and exact returned-card comparisons.
- Document component ownership and remaining architecture gaps. The index uses local SQLite operations and makes no model calls.

## 0.3.9

- Make the idle-maintenance continuation test advance the real scheduling callbacks with a controlled clock instead of a 1.5-second wall-clock deadline. Preserve completion assertions and additionally verify that pausing prevents further model calls.
- Limit concurrent SQLite-heavy test workers to two so slower Windows CI runners do not contend for every CPU's disk access. All test files still run.
- Runtime memory, recovery, retrieval, persona and session behavior are unchanged from 0.3.8. The test-only hotfix addresses its failed CI timing check; it does not claim new runtime repairs.

## 0.3.8

- Preserve the native result or original error when an in-flight tool completes after the memory plugin unloads; do not touch the closed old journal or replace the outcome with a database error.
- On the next step after reload/restart, reconcile a previously unrecorded explicit native success only when session, call ID, tool name, argument digest, native ordering and available source links match. Never replay the operation.
- Keep genuinely missing results, recorded unknown failures, conflicting duplicate evidence and completed human reviews unchanged. Persist native call references and bound recovery scans; unchanged checks do not rescan full history each round.
- Add isolated actual-host unload, same-session persistence/restart and repeat-reload verification, with a genuine unknown-result control and exactly one synthetic effect.

## 0.3.7

- Separate native unread/missing-file edits, missing or ambiguous literal matches, invalid edit/write arguments, unread overwrite refusals, and genuinely absent tools from unknown outcomes using native identity and stage evidence. A custom tool reporting the same error code does not inherit proof; unavailable registry lookups fail closed. Keep actual started-write interruptions for human review.
- Recognize validated foreground shell metadata without widening command syntax. Preserve raw sources and existing unresolved history.
- Let the authenticated human manager review a specific older uncertain operation while a main request is running, without releasing its lease or replaying any action. Live running operations cannot be acknowledged this way.
- Refresh newly pending review rows and the jump target, retain drafts during same-library refresh, isolate drafts between libraries, and display time/error/stage in both languages.
- Page claim relationships with library/source-bound keyset cursors plus independent character pages. Keep complete attribution and retraction explanations reachable.
- Pair retrieved early accepted revisions with the latest accepted state beyond 100 revisions; preserve case, word boundaries and significant punctuation. Prefer native source order over delayed archival time.
- Retain readable short summaries and quotes within the same 120-character card and 650-character compact response budgets, dropping whole lower-ranked cards when needed.

## 0.3.6

- Recognize native grep/glob and literal-only PowerShell diagnostics during recovery; migrate historical read-only misclassifications without replay. Evidence-backed local memory edits and checkpoint saves remain available; normal operation adds no plugin tool-approval gate.
- Add attributed changed/corrected/disputed/contextual claim links, evidenced retraction, bounded chain traversal, branch warnings, accepted-state version pairs, and a narrow unresolved preference-conflict cue. No general automatic truth adjudication.
- Bring linked before/after evidence into lookup and freshly revalidated working memory within existing compact budgets. Raw sources, persona files, native chat and ownership are preserved.

## 0.3.5

- Recall the newly claimed input before the first native model request; deduplicate by stable message identity after persistence. Preserve the existing request prefix.
- Add a covering index for legacy source checks and avoid repeated status scans. Interrupt background vector work for foreground input; resume pending indexing after startup and explicit recovery.
- Strip known QQ transport envelopes from retrieval projections only, and rebuild only affected derived indexes. Originals and persona files remain unchanged.
- Add verbatim quote excerpts within the existing 120-character card / 650-character response budgets. Label dialogue, tools, authored legacy files and other notes separately; apply bounded source priors. Display ranking points, not confidence probabilities.
- Make owner identity, incomplete indexing and pending-operation review prominent in both management languages. Operational indicators refresh without overwriting forms.
- Keep chat and supported read-only diagnostics available during uncertain-write review; provide an actionable local manager command without exposing authentication. Never replay uncertain actions automatically.

## 0.3.4

- Recognize a conservative literal-only shell diagnostic grammar and DSH working-directory reads during recovery. Read-only diagnostic interruptions do not quarantine later tools.
- Preserve review requirements for uncertain external writes, arbitrary shell execution, substitutions, executable search flags, and file redirections.
- A working-memory deadline now affects that recall attempt instead of permanently pausing the shared embedding service. Later turns can retry.

## 0.3.3

- Display current native session titles in the management selector and library ownership summary, keeping operation targets as stable IDs.
- Add English and Simplified Chinese documentation and a management-page language selector.

## 0.3.2

- Mark the delivered scope explicitly as completed and stable.
- Replace the inherited experimental status filename with RELEASE-STATUS.md.
- Keep validation evidence, runtime defaults, and documented capability limits unchanged.

## 0.3.1

- Neutral English branding, independent repository, and a fresh public history.
- Removed deployment-specific names, hard-coded legacy identity, private paths, and historical development materials from the public tree.
- Optional legacy imports now require embedding.legacyNamespace and use a bound SQL parameter. No personal namespace default is embedded in the package.
- Memory-tool replay exclusion recognizes generic memory-tool namespaces.
- Synthetic actor labels replace personal-looking names. Historical narrative reports are not republished as if they measured the renamed corpus.
- Public source, package archives, and commit history are reviewed independently of the original development workspace.

The underlying retrieval, working-memory budgets, source integrity, recovery, and explicit owner handoff behavior are retained from the 0.3 engine. See docs/VALIDATION.md for evidence and limits.
