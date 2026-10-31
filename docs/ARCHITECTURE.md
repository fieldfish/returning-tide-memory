# Architecture

~~~mermaid
flowchart TD
  Host[DSH events and model loop] --> Capture[Raw and structured capture]
  Capture --> Store[(SQLite library)]
  Store --> Index[Local embedding and lexical candidates]
  Store --> Maintenance[Budgeted incremental extraction and consolidation]
  Maintenance --> Situations[Versioned states and situations]
  Index --> Gate[Source and relevance checks]
  Situations --> Gate
  Gate --> Working[Bounded working memory]
  Working --> Host
  Store --> Recovery[Checkpoints and uncertain-action review]
~~~

Raw records remain separate from mutable state and situation projections. Source references, ancestor availability, digests, native positions, and revisions protect against stale or circular evidence. Maintenance reports stay in the raw archive but are excluded from new model-derived experience inputs. Pure maintenance batches advance cursors without model calls.

SourceLog uses monotonic ingest positions; extraction and consolidation have independent cursors, Unicode fragments, and restartable progress. They share idle scheduling and call budgets. Model calls occur outside transactions; commits revalidate ownership, source stamps, configuration, and revisions.

Situation vectors cover finite valid projections, not every detail of an unlimited archive. Working memory uses triggers, deduplication, relevance gates, and total context budgets. Nearby scenes preserve original speaker/time context rather than inventing emotions or causes.

Feedback modifies retrieval salience, not persona files or raw statements. Semantic correction cues are derived local vectors with independent health, source validity, and revocation. A current-tool-source pointer identifies a real return from the current turn without presenting it as historical proof or task completion.

ExecutionLedger and RecoveryJournal share operation state. Internal transactional control is inspected after restart without inventing external uncertainty. Real uncertain external actions remain blocked from blind replay. Host-specific lifecycle wiring remains in index.mjs.

Retrieval uses a source-aware projection: known bridge envelopes are stripped only for recognized bridge messages. Migration invalidates affected chunks/vectors, never source rows. Compact cards add exact source substrings; summaries are extractive navigation hints, not fact judgments. Mild source-class priors distinguish authored files from dialogue after semantic admission; displayed points are rescaled reciprocal-rank fusion, not probabilities.

The pre-step hook reads claimed incoming messages before native persistence and deduplicates later steps by message ID. The native host refreshes registered runtime-context providers before dispatch. Background local indexing yields to foreground input, and unfinished indexes resume on startup. The default recall deadline is eight seconds; deadline cancellation does not persistently pause embeddings. Incomplete indexing remains visible even if some candidates are ready.
