# Validation

## 0.3.11 recovery feedback

On Windows with DSH NEXT 2.0.19-next and the 0.2.1-rc.2 SDK, test both the global tool registration and a separately composed standard preset using its four shipped tool entries. Each run uses a temporary home, isolated memory, an offline failing web provider and synthetic video tools. The test inspects the actual operation rows, pending counts and the files touched by the controls.

| Single call in the standard preset | 0.3.9 / 0.3.10 pending | 0.3.11 pending |
| --- | ---: | ---: |
| Official edit before its required read | 1 | 0 |
| Official PowerShell with invalid arguments | 1 | 0 |
| Official web fetch with a failing provider | 1 | 0 |
| Synthetic video metadata read, registered with the new read contract in 0.3.11 | 1 | 0 |
| Synthetic file write that takes effect before an error | 1 | 1 |

The Windows release gate requires 441 passing offline tests against the extracted package with the optional SDK enabled. Each of the two host compositions checks 11 feedback cases and six native filesystem refusals. The checks include a registered storyboard timing out in inspect and save modes, read access during review and same-name replacements after side effects. A separate same-session restart test counts exactly one fixture effect. The management checks cover 14 official tool schemas and 17 bilingual desktop/mobile flows.

To reproduce the host runs on Windows, set `DSH_SDK_RUNTIME` to the installed runtime directory. Run `npm run test:native-failures`, `npm run test:preset-recovery` and `npm run test:reload-recovery`. The standard composition test requires the SDK's `dsh-web-app` standard preset. These runs use no live user conversation or cloud dialogue model.

The 0.3 engine completed 330 offline checks, official host tool-schema validation, desktop/narrow-browser UI verification, consistent legacy-copy migration and restore checks, 1000 synthetic lifecycle cycles, and a three-minute isolated actual-host observation. Two actual DSH/DeepSeek handoff scenarios verified fresh-session recall, preference revisions, unfinished-task continuation, actual native compaction, normal host restart, specific corrections, separate similar projects, source-adjacent context, and unsupported-history abstention. Those tests used synthetic experiences and did not modify a live user companion.

Version 0.3.1 changes branding, deployment-specific legacy selection, and neutral fixtures. The current offline tests and privacy audit are rerun on the exact public tree. Generic legacy namespace selection, read-only import, parameterized selectors, and replay exclusion have additional tests. The previous two dialogue scenarios are engine evidence; they are not described as newly rerun after fixture renaming.

Run npm test and npm run check without model credentials. npm run soak:activity uses synthetic temporary data. recall:* evaluations require the configured local Ollama embedding; they do not call a cloud dialogue model. Renamed fixtures can change measured retrieval ranks, so historical numeric retrieval results are not rewritten and republished as measurements of this corpus.

Compatibility evidence covers the installed DSH NEXT host/SDK combination on Windows and Node 24.22.1. The package declares Node >=22.13, but does not claim an exhaustive host/OS matrix. Fast loops and a three-minute observation do not prove weeks of uptime. Developer-authored examples are not an independent blind study, and no test proves subjective identity continuity or perfect recall.

Version 0.3.5 additionally exercises the installed native SDK with an isolated synthetic adapter: the first pending user message receives its source card in the actual outgoing request, a new topic removes the old working card, and previously sent request messages remain an unchanged prefix. This checks lifecycle wiring, not cloud-model answer quality. Regression cases cover bridge-only projection migration, verbatim quotes and budgets, source labels and priors, foreground cancellation, ownership messages, read-only recovery, and indexing notices. Private-record benchmarks and deployment evidence are deliberately excluded from the public package.

Version 0.3.6 passes 373 offline checks, including historical host-name migration, recovery-local writes, literal PowerShell reads versus writes, exact-quote claim links, owner/library boundaries, relationship retraction, chains and forks, current-turn exclusion, accepted versus pending state versions, live working-frame revalidation, and shared character budgets. The installed official SDK was exercised in a separate profile with a pending synthetic external operation: actual native grep/glob/pwsh reads succeeded, an external write did not execute, and two synthetic outgoing requests retained working-memory recall and the old request prefix. These tests do not send messages to a live companion or prove general semantic contradiction detection.


Version 0.3.7 was independently verified with 412 passing tests and no skips in the tested Windows environment, including a real headless-browser review regression and the optional official policy contract enabled via DSH_SDK_RUNTIME. A separate 17-case reviewer set covers deep accepted history, character budgets, native source chronology, restart classification, unavailable registry evidence, busy human acknowledgement, live-operation protection, dynamic review rows, same-library drafts and cross-library draft isolation. An isolated official host profile additionally exercises real unread edit refusal, absent tools, successful read-then-edit, scoped tool replacement, custom effects followed by matching error codes, and cancellation before versus after execution. It makes no cloud model calls and sends no messages to a live companion. All 14 official tool schemas and bilingual desktop/mobile management flows were checked. This is regression and integration evidence, not a weeks-long uptime measurement or a new cloud-model continuity trial. The optional SDK contract test skips when DSH_SDK_RUNTIME is absent; browser tests require a locally available Chromium-family browser.


This release is the false-hold repair stage. Automatic recovery of a missed persisted tool result after interruption, unrelated host UI stalls and general semantic adjudication are separate follow-up work, not claimed complete here. Real unknown started writes still require human review; upgrades do not erase old unresolved records.

To reproduce the complete native failure matrix, set DSH_SDK_RUNTIME to an existing DSH runtime directory and run npm run test:native-failures. The runner creates a separate temporary home, copies an explicit runtime file list (no directory links), uses synthetic files and a local fake embedding endpoint, and makes no cloud dialogue-model calls. It covers real native no-effect refusals, successful read/edit, tool replacement, cancellation and custom tools producing effects before reporting matching error codes. Diagnostic artifacts are retained in the printed temporary directory; it never deploys or edits a real chat.


## 0.3.8 interruption recovery stage

Release note: the local validation below passed, but the original 0.3.8 shared Windows CI exposed a timing-dependent idle-maintenance test failure. That release is marked prerelease; 0.3.9 repairs the test timing without changing runtime code.

422/422 tests pass with no skips in the tested Windows SDK environment. New regressions reproduce unloading during a successful/failed/throwing tool, missed persisted successes after restart, genuine missing outcomes, changed arguments, incorrect source citations, user-authored or contradictory envelopes, late results after reload, scan caching and preservation of completed human review. The earlier 17-case independent review, native refusal matrix, tool schemas and bilingual UI are rechecked for the release package.

Set DSH_SDK_RUNTIME to an installed runtime directory and run npm run test:reload-recovery. The isolated actual-host test completes one synthetic local effect while unloading the memory plugin, persists a valid native call/result lifecycle, restarts the host into the same session, reconciles that exact result and reloads again without a new acknowledgement. It preserves a separate truly unknown operation, the original source and session ownership, and verifies exactly one effect and zero dialogue-model calls. The lifecycle is synthetic and uses official SDK message/event constructors; no live companion is contacted. Unrelated host UI stalls and arbitrary third-party execution semantics are not proven resolved by this test.

## 0.3.9 CI timing hotfix

422/422 local tests pass with the optional SDK enabled. The idle-maintenance test now advances real scheduler callbacks with a controlled clock, asserts that every batch completes, and verifies that pause prevents further model calls. An isolated mutation that removes continuation fails this same test, confirming the fix does not hide a broken scheduler. The runner executes all test files with two concurrent workers. Runtime source files are unchanged from 0.3.8; the earlier native-host and UI evidence applies to that identical runtime, rather than being claimed as newly repeated.

## 0.3.10 lexical index

434 offline tests with the optional official SDK enabled cover the normal retrieval entry point, pending and built indexes, long-record tails, ASCII substrings, raw QQ preservation, semantic-only recall, retired sources, payload insert/update/delete, transaction rollback, reopen, cancellation during a yielded turn, foreground priority and disposal barriers. The SDK refusal/reload runners and 14 tool schemas plus bilingual management flows were rerun against this runtime. Measured synthetic performance and its limits are in [LEXICAL-BENCHMARK.md](LEXICAL-BENCHMARK.md).
