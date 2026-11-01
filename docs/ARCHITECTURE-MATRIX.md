# Component ownership and verification

This map describes Returning Tide Memory's implemented scope. A derived index can be rebuilt from its source. It must not silently become a replacement authority for the original event.

| Responsibility | Owner | Verification and boundary |
|---|---|---|
| Original events | `records`, capture and activity archival | Source identity, library scope and provenance checks. Structured activity capture is optional. Automatic full player/video observation remains outside this release. |
| Lexical candidates | `LexicalIndex` | Persisted pair/window index. Pending and oversized rows remain searchable through current-text verification. Activity payload changes invalidate derived entries. |
| Semantic candidates | `Embedding` | Stored normalized vectors, local query embedding and exact dot products. Vector candidate scanning remains linear in indexed parts. |
| Retrieval results | Hybrid ranking, source availability and cards | Current source checks, existing relevance gates, source priors and compact cards. Scores are ranking values. |
| Changed beliefs | State history, claim links and memory dynamics | Attributed revisions and explicit corrective links, with bounded traversal. General automatic truth adjudication remains an engineering gap. |
| Current working context | Working memory, scenes and context frame | Triggered retrieval, source-adjacent context, provenance and character budgets. Optional working memory must be enabled explicitly. |
| Goals and completion | Versioned task checkpoints and execution ledger | Explicit task state and recorded steps. Goal choice and completion criteria still require the agent/user to supply a suitable task definition. |
| Session continuity | Explicit owner binding, handoff and recovery | One active owner, source-matched persisted results, snapshots and human review for genuinely unknown effects. |
| Background maintenance | Idle scheduler and embedding lifecycle queue | Incremental batches yield between rows, respond to cancellation and complete before database shutdown. Long-running uptime needs operational evidence beyond these regression tests. |

The 0.3.10 release changes lexical candidate lookup and its maintenance. It preserves the existing retrieval result contract. Performance evidence and reproduction steps are linked in [VALIDATION.md](VALIDATION.md).
