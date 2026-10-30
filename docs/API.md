# Tool API

| Tool | Purpose |
| --- | --- |
| cm_library | Create, list, bind, handoff, rename, configure library settings, inspect health, and resume repaired features. |
| cm_lookup | Hybrid source candidates; default 3, maximum 5 five-field cards; each full card <=120 Unicode characters. |
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
| cm_working | Status, clear, focus, attributed feedback, feedback status/retraction, and correction-index resume. |
| cm_activity | Status/list/read/resume/observe for structured activity records and timestamped reports. |

All writes are scoped to the owning main session. Use returned IDs, not invented identifiers. Short source IDs must be unambiguous. State, situation, and checkpoint revisions prevent stale writes. Existing-title situation updates can derive their top-level provenance from individually validated assertion references; every reference still belongs to the input batch.

cm_working focus(query) declares the current attention point and schedules bounded recall. It does not mark the previous task complete. Save a checkpoint before switching unfinished work. feedback requires a target ID, later source refs, kind, and reason; corrected/invalidated additionally require a specific cue. feedback-status without an ID lists recent feedback; with an ID it inspects that source. Merely retrieving or reading never writes positive feedback.

cm_activity read defaults to 1200 and supports at most 6000 characters; part is payload or metadata. list defaults to 5, maximum 10 records. observe requires a title, body, 1-5 valid source references, and an idempotency key; video reports additionally need a source URL and start_ms/end_ms. observed_at is a declared time, separate from recording time. A report is not independent verification. resume rescans existing native logs, never replays tools.

cm_evidence is off unless evidenceEnabled is explicitly configured. It shares the model budget with extraction and consolidation. Current-state verification also checks accepted revision and time. Sources, ancestors, native turn positions, cancellation, and revisions are rechecked after model responses. Retrieval alone never proves answerability.

Manual tool results have their own pagination; the 800/1800 automatic context budget does not erase host history or limit every manual response. Complete parameter schemas are registered by index.mjs.
