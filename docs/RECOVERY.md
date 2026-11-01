# Recovery

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

Open the local manager and choose **查看并处理 / Review pending operations**. Verify the particular operation against its target or receipt, record the decision, and continue. Upgrading does not retroactively certify old holds. Elapsed time cannot establish whether a write took effect. Hard termination before a dynamically recognized reader returns can still leave a review item, because its final identity and mode could not be checked. Recovery never resends the old call.

Literal-only diagnostic shell commands in a conservative supported subset, and working-directory reads with no cd argument, remain available while an external write awaits review. Unsupported shell syntax stays gated. Missing results from a recognized read-only diagnostic do not create an external-write quarantine after restart. Review never silently replays an old action.

A working-memory recall deadline only makes that working set unavailable for the current attempt. It does not permanently pause the shared vector service. Actual backend failures remain visible and can require explicit recovery.

A model transport failure ends the request without automatic retry and is not proof of library corruption. Embedding, situation indexing, correction indexing, activity capture, and background maintenance have independent health. Chat and raw archival can continue when optional recall is unavailable; tasks dependent on unknown old progress should wait for evidence.

After repairing a service, resume the relevant feature explicitly. Activity resume only rescans existing native events. Correction resume discards derived cue vectors and rebuilds them during maintenance. Neither action replays prior desktop tools or sends messages.

An uncertain external action remains reviewable and must not be replayed simply because a process restarted. Use the authenticated local manager to inspect actual external evidence and record a decision. An internal control-tool validation error has no uncertain external effect; its state is inspected transactionally without assuming it committed.

Do not delete the library or force-remove a live lock to bypass an error. Keep original sources, checkpoints, snapshots, and diagnostic records. Stop old execution and use explicit owner handoff instead of creating a second active writer.
