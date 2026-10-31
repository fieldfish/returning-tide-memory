# Tool API

| Tool | Purpose |
| --- | --- |
| cm_library | Create, list, bind, handoff, rename, configure library settings, inspect health, and resume repaired features. |
| cm_lookup | Hybrid source candidates; default 3, maximum 5 six-field cards (id, title, score, summary, time, quote); each full card <=120 Unicode characters. |
| cm_read | Raw source by ID; character pagination, default 2000, maximum 6000. |
| cm_self | Propose, accept, defer, get, list, history, timeline, and related versioned states. |
| cm_checkpoint | Write/read actual task progress and next steps with source references and revision checks. |
| cm_task | Plan, activate, pause, resume, list, status, and verify execution steps. Planning is not execution. |
| cm_extraction | Configure, inspect, pause, and resume incremental state extraction. |
| cm_evidence | Optional model-assisted supported/contradicted/insufficient assessment with exact source quotations. |
| cm_report | Usage and library reports. |
| cm_delete | Explicit source deletion and dependent-reference cleanup; not deletion of host logs or backups. |
| cm_situation | Create/update versioned situations, attach sources, focus, link/unlink, search, and maintain indexes/consolidation. |
| cm_scene | Source-adjacent conversation with speakers, timestamps, and provenance. |
| cm_working | Status, clear, focus, attributed feedback, feedback status/retraction, correction-index resume, and sourced claim links. |
| cm_activity | Status/list/read/resume/observe for structured activity records and timestamped reports. |

All writes are scoped to the owning main session. Use returned IDs, not invented identifiers. Short source IDs must be unambiguous. State, situation, and checkpoint revisions prevent stale writes. Existing-title situation updates can derive their top-level provenance from individually validated assertion references; every reference still belongs to the input batch.

cm_working focus(query) declares the current attention point and schedules bounded recall. It does not mark the previous task complete. Save a checkpoint before switching unfinished work. feedback requires a target ID, later source refs, kind, and reason; corrected/invalidated additionally require a specific cue. feedback-status without an ID lists recent feedback; with an ID it inspects that source. Merely retrieving or reading never writes positive feedback.

cm_activity read defaults to 1200 and supports at most 6000 characters; part is payload or metadata. list defaults to 5, maximum 10 records. observe requires a title, body, 1-5 valid source references, and an idempotency key; video reports additionally need a source URL and start_ms/end_ms. observed_at is a declared time, separate from recording time. A report is not independent verification. resume rescans existing native logs, never replays tools.

cm_evidence is off unless evidenceEnabled is explicitly configured. It shares the model budget with extraction and consolidation. Current-state verification also checks accepted revision and time. Sources, ancestors, native turn positions, cancellation, and revisions are rechecked after model responses. Retrieval alone never proves answerability.

Manual tool results have their own pagination; the 800/1800 automatic context budget does not erase host history or limit every manual response. Complete parameter schemas are registered by index.mjs.

## Attributed claim relationships

`cm_working` action `link` takes `id` (earlier source), `target_id`, `relation`, `subject`, `topic`, `scope`, `source_quote`, `target_quote`, and `reason`. Both quotations must occur exactly in their source. `changed` records an attributed change; `corrected` records an attributed correction, not independent truth; `disputed` keeps an unresolved disagreement; `contextual` distinguishes circumstances. Changed/corrected edges require ordered sources and cannot form a cycle within the same subject/topic/scope. The sources and persona stay unchanged.

`link-status` takes a source `id` and returns character-paginated relationships and full attribution/evidence. `link-retract` takes `link_id`, `reason`, and 1-3 independent later source `refs`; retraction is audited and does not silently reactivate when a duplicate link is submitted.

Lookup and automatic working memory follow existing links from either endpoint, and accepted state revisions bring previous/current source pointers together. The extra `relations` metadata sits outside each six-field card; manual lookup remains <=650 characters, automatic context retains its existing 800/1800 limits. Fewer cards may fit when relationships need space. Bounded traversal marks `more` rather than claiming an intermediate update is final. Branches remain disputes. Read full sources and relationship details before drawing conclusions.

There is no automatic general-purpose semantic adjudicator. A narrow same-speaker opposite-preference cue can flag a possible conflict only among retrieved candidates; it creates no durable verdict. Other durable links must be explicitly recorded with evidence. Existing accepted state history is reused automatically. Unknown contradictions elsewhere in the archive can still be missed.

## Recovery tool compatibility

DSH `grep` and `glob` are host filesystem-search tools, not extra memory plugins. They remain available during uncertain-operation review. Previously misclassified interrupted searches are reclassified on startup without replaying them or inventing their results. Read-only literal PowerShell diagnostics are recognized separately from shell commands. This is a limited command grammar, not a complete PowerShell safety analyzer; arbitrary scripts, writes, redirections, expansions, background commands, and unknown options still require review while an external outcome is uncertain.

Evidence-backed local memory edits, focus changes and checkpoint saves remain available during review. They are local writes, not classified as read-only, and cannot replay an external action. Binding, destructive deletion and uncertain external writes remain subject to their existing checks. Outside recovery review this plugin adds no general tool approval policy. Host permissions, workspace rules and owner checks remain independent.


## Relationship pages and source order

`cm_working link-status` accepts `relation_limit` (1-20, default 5) and `relation_cursor`. Pass back `relation_page.next_cursor` unchanged to select the next relationship batch. The cursor is bound to its library and source; changed, invalid or cross-library cursors are rejected. `offset`/`limit` independently page the selected batch's full JSON text. Only small continuation metadata is outside that character page; full stored scope, reason and retraction evidence are not silently clipped. Live keyset pagination is not a frozen snapshot: newer insertions are found by starting again from page one.

Verified reports use their native session/sequence for same-session chronology, even when archived later. Separate sessions require a strictly later comparable timestamp; equal or unorderable positions do not establish a later correction. An accepted-state history lookup can pair an early source with the latest accepted revision without a 65-revision window. Pending or expired state is not substituted as current truth.

## Human review and failure stages

The journal distinguishes a host-proven pre-effect native edit-intent refusal from an execution whose effect is unknown. Absent tools require a successful registry lookup; an unavailable lookup is not proof of absence. Native filesystem classification additionally freezes the visible global definition, execution function and parameter contract, and rechecks them after the result. Unread or absent edits require the corresponding rejected edit intent; literal-edit matching refusals require an accepted edit intent and the native atomic-provider contract. A create-only write refusal requires its accepted createIfAbsent intent. Argument refusals require both the canonical ToolArgsError and violations from the official host schema validator. Missing validation support or a changed definition cannot certify non-execution. This relies on the trusted host registry and its stage contract, not a security boundary against privileged plugins modifying the host. Same-named scoped replacements and composite error codes do not inherit native proof. Error text alone is never parsed to certify non-execution.

An authenticated local human can acknowledge one older `uncertain` item during an active request. This changes only review metadata, keeps the current request lease, does not acknowledge a still-`running` operation, and never replays a tool. Other configuration, ownership transfer, retry permission and verification actions retain their own guards. This does not disable DSH's independent host approval policy. Existing historical unknown outcomes are not automatically cleared on upgrade.

Pending rows refresh with the health indicators; their drafts remain scoped to the library and operation. The page shows recorded time, failure code and stage where known, without exposing raw arguments or credentials. A normal tool refusal no longer becomes a global unknown-write hold through these verified native paths; a genuinely unknown started write still needs human review.
