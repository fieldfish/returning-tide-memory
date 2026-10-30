# Migration and rollback

Schema remains 3. New additive tables still require the corresponding code to maintain their source dependencies. An older implementation opening the same schema number is not equivalent behavior. First create a consistent snapshot and rehearse in a separate copy. Older schema upgrades create a pre-migration snapshot before changes.

Version 0.3.1 is packaged as dsh-returning-tide-memory. The internal host identifier continuity-core, cm_* tools, and database application identifier remain stable. Do not load both old and new implementations against one live library. Replacing an active deployment requires explicit operator planning, saved native sessions, and reviewed pending operations.

Optional compatible legacy indexes require embedding.legacyIndexPath, embedding.legacyNamespace, and the matching legacy session binding. Namespace is explicit and passed as an SQL value; there is no embedded personal namespace. The source index is opened read-only. Do not guess an unrelated database format or namespace. Missing configuration fails before import.

A snapshot includes the SQLite library, not persona files, native host logs, artwork, credentials, or model weights. Save those independently. Restore only into a new directory. A restored copy is unbound and paused until reviewed. Never overwrite the original to simulate a rollback; use a reviewed pre-upgrade copy and account for subsequent records.
