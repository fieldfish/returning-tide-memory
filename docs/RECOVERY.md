# Recovery

## Third-party parameter errors

In a managed session, a tool with an SDK-supported parameter schema can report a missing field or a type error before the provider starts. The journal records `not_started / schema-preflight`. Correct the indicated field and submit a fresh call. For example, a numeric `cells` field accepts `4` and rejects `"4"`, including for raw plugins that used to coerce the string. An existing recovery hold still takes precedence.

Validation inside a provider can run after a write. If such a provider reports `INVALID_ARGS`, a missing read or execution-stage guarantee leaves the operation pending for review. The same conservative handling applies when the installed SDK cannot verify the declared schema. Historical pending rows keep their original evidence and review flow.

## 0.3.12 provider checks and process interruption

During recovery, official filesystem search/read tools and supported diagnostic PowerShell or working-directory calls require a matching provider in the active scope. Third-party aliases (including shell or search aliases) need an explicit provider declaration to keep operating during review. Installed local memory operations are checked against their own registered definition. A historical unknown cannot be resolved from its spelling. In ordinary sessions unrecognized external tools can still run.

Register third-party readers using the current `read-contract` export. Its wrapper checks the mode again and commits a SQLite entry for this session, call, tool and argument digest before entering provider code. After a crash a verified in-flight read becomes a failed read with no result. The guard cannot certify side effects in a provider that falsely declares its own behavior. A crash before provider-entry evidence, or an older bundled registration helper without the entry callback, can still require review.

Upstream integration was tested with [dsh-video-vision v1.4.3](https://github.com/Destinhue/dsh-video-vision/tree/v1.4.3) and a synthetic local MP4. An integration adapter registered only metadata reads of that fixture. The original storyboard implementation submitted a real PNG to the attachment sink and kept write handling. The upstream package itself is distributed separately.

## Tool failures in desktop and global profiles

Starting in 0.3.11 the recovery journal checks the active official tool registration in the current session or its parent scopes. It checks tool identity and parameters again when the result arrives. A native edit rejected by the filesystem before changing a file is recorded as `not_started / pre-effect`. An official PowerShell call whose arguments fail the host schema and return its native validation error is recorded as `not_started / pre-validation`. A PowerShell command that starts and then fails may already have changed something.

Official `web_fetch` is recognized as a retrieval operation. An observed failure is recorded as `failed / read-only`. Chat, supported diagnostics, official fetch and registered read modes stay available while an unrelated write awaits review. A tool with the same name registered by another provider does not inherit these new contracts. Each decision can record its origin, stability of the definition, schema rejection and filesystem-intent stage in the local audit journal. The classification metadata omits raw arguments and file contents.

### Declaring a third-party reader

Use the public package export when registering the tool in its own scope. A provider which supports both inspection and output files should allow only its strictly read-only argument shape. For example, if its documented arguments are exactly `mode` and `source` for inspection:

```js
import { registerReadOnlyTool } from 'dsh-returning-tide-memory/read-contract'

const dispose = registerReadOnlyTool(ctx, videoProbeDefinition, args =>
  args?.mode === 'inspect' && typeof args.source === 'string' &&
  Object.keys(args).every(key => key === 'mode' || key === 'source')
)
```

A tool whose **every** mode is read-only may omit the predicate. Declare only modes that cannot create or overwrite a user file, send a message, upload, or change external state. Check the implementation as well as the parameter names. A storyboard generator that saves an image needs write handling. Undeclared video tools continue to use conservative recovery. The predicate must synchronously return the boolean `true`; a missing declaration, exception, promise, changed registration or renamed copy confers no permission. This API relies on the accuracy of installed provider code.

### An existing item is still pending

Open the local manager and choose **查看并处理 / Review pending operations**. Verify the particular operation against its target or receipt and record the decision. Upgrading preserves old holds. A declared read interrupted after its 0.3.12 provider-entry marker can be settled automatically. An interrupted write without a receipt still needs review. Recovery never resends the old call.

Literal-only diagnostic shell commands in a conservative supported subset, and working-directory reads with no cd argument, remain available while an external write awaits review. Unsupported shell syntax stays gated. Missing results from a recognized read-only diagnostic do not create an external-write quarantine after restart. Review never silently replays an old action.

A working-memory recall deadline only makes that working set unavailable for the current attempt. It does not permanently pause the shared vector service. Actual backend failures remain visible and can require explicit recovery.

A model transport failure ends the request without automatic retry and is not proof of library corruption. Embedding, situation indexing, correction indexing, activity capture, and background maintenance have independent health. Chat and raw archival can continue when optional recall is unavailable; tasks dependent on unknown old progress should wait for evidence.

After repairing a service, resume the relevant feature explicitly. Activity resume only rescans existing native events. Correction resume discards derived cue vectors and rebuilds them during maintenance. Neither action replays prior desktop tools or sends messages.

An uncertain external action remains reviewable and must not be replayed simply because a process restarted. Use the authenticated local manager to inspect actual external evidence and record a decision. An internal control-tool validation error has no uncertain external effect; its state is inspected transactionally without assuming it committed.

Do not delete the library or force-remove a live lock to bypass an error. Keep original sources, checkpoints, snapshots, and diagnostic records. Stop old execution and use explicit owner handoff instead of creating a second active writer.
