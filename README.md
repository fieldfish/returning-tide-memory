# Returning Tide Memory

[English](README.md) | [简体中文](README.zh-CN.md)

Local long-term retrieval, contextual working memory, and sourced continuity for DSH.

**Status: Completed — stable release.** See [release status](RELEASE-STATUS.md) and [implemented scope](docs/STATUS.md).

Returning Tide Memory archives host-visible conversation and tool events in a separate SQLite library. It retrieves small evidence cards, follows source references, reconstructs nearby conversation, and carries versioned state and unfinished tasks across explicit handoffs.

It does not rewrite persona files. A retrieved passage is a candidate, not proof that an event happened. Plans, reports, creative writing, host tool results, and verified outcomes remain distinguishable.

## Features

- Local Ollama embeddings plus lexical retrieval; optional finite situation-summary vectors.
- Six-field lookup cards: id, source-labeled title, ranking points, summary, time, and a short verbatim quote. Each complete card is at most 120 Unicode characters, with at most five cards. Summaries shrink to share the unchanged budget; full originals are read separately. Ranking points are not probabilities.
- Event-triggered working memory: messages, tasks, tool failures, visible activity hints, and explicit focus changes. Normal automatic context is capped at 800 characters; expanded or recovery context at 1800.
- Versioned self-reports and situations, source attribution, nearby conversation windows, checkpoints, and one active owner per library.
- Time-based fading without automatic raw-source deletion. Evidence-backed usage feedback can reinforce, correct, or invalidate a specific cue; exposure alone earns nothing.
- Optional structured tool archival and timestamped activity reports. Tool requests, host returns, and reported observations are separate.
- Explicit recovery for uncertain external actions; local transactional control errors do not become unresolved external side effects.
- Local management UI, independent feature health, incremental idle maintenance, shared model budgets, consistent snapshots, and restore into a new unbound copy.

## Requirements

Node >=22.13, a compatible DSH host, and local Ollama with qwen3-embedding:0.6b. The tested host environment is documented in docs/VALIDATION.md. Model weights, DSH itself, account credentials, and user libraries are not bundled.

## Install

1. Download a release archive and unpack it into a new directory.
2. Run npm test, npm run check, and node cli.mjs --doctor.
3. Change dataDirectory in cordis.patch.yml to a NEW absolute path.
4. Load the local package through the DSH client plugin manager or its profile CLI, for example:

~~~text
dsh plugin --profile YOUR_TEST_PROFILE add "link:C:\agent-test\returning-tide-memory"
~~~

5. Enable manager.enabled, then use node cli.mjs --data YOUR_ABSOLUTE_DATA_DIRECTORY --open-manager. Create a library and bind an idle loaded main session.

Optional automatic features default to off. Enable only the ones you want in a separate test profile:

~~~json
{
  "workingMemory": {"enabled": true},
  "memoryDynamics": {"enabled": true, "semanticThreshold": 0.84},
  "situationIndex": {"enabled": true},
  "activityArchive": {"enabled": true, "maxPayloadBytes": 1048576, "redactCredentials": true}
}
~~~

Background extraction/consolidation additionally requires explicit model configuration, budgets, and separate resume operations. Saving configuration does not start paid calls. Embeddings use the configured localhost service.

## Documentation

The local management page supports English and Simplified Chinese. Select the language at the top of the page. Session selectors show the current DSH conversation title; stable IDs remain available in expandable details and continue to identify every operation. Language changes affect interface text only, preserving archived material and user titles.

[Tool API](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) · [Installation](docs/INSTALL.md) · [Migration](docs/MIGRATION.md) · [Recovery](docs/RECOVERY.md) · [Privacy](docs/PRIVACY.md) · [Validation](docs/VALIDATION.md) · [Changes](CHANGELOG.md)

## Scope

Retrieval is probabilistic. Successful archival does not guarantee perfect recall, subjective identity continuity, or indefinite uptime. Only visible and successfully stored events can be retrieved. Activity reports do not prove actual viewing, game progress, or external success. Automatic player observation and full image/audio/video carrier storage are not included.

The project is independent of desktop companion applications. Public examples use synthetic actor labels; no user persona, private conversation, account identifier, real workstation path, credential, database, or private implementation journal is shipped. Chinese-language UI and retrieval support remain available, while project branding and actor identifiers are neutral.

MIT. See [third-party notes](docs/THIRD-PARTY-NOTES.md). DSH owns the model loop; this package does not require LangGraph.
