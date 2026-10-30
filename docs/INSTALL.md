# Installation

Use a new test profile and an absolute dataDirectory. Install the unpacked local package using the client plugin manager or a link: package supported by the target DSH distribution. The package exports its host bundle through cordis.patch.yml.

The host must provide tools, agents, sessions, system prompts, llm.prepareCall, and the lifecycle hooks used by index.mjs. If an external link cannot resolve the matching host SDK, set runtimePackageJson to the actual runtime package.json for that DSH installation; do not point it at an unrelated SDK version.

Local embedding defaults to http://127.0.0.1:11434 and qwen3-embedding:0.6b. Remote embedding URLs are rejected. This package does not install the host, model weights, desktop control tools, messaging bridges, or speech services.

Enable manager.enabled and open it with node cli.mjs --data YOUR_ABSOLUTE_DIRECTORY --open-manager. It binds only to loopback and uses a private access token file. Do not expose it directly to the internet or paste its token into model context.

Create a named library and explicitly bind an idle main session. A library has one active owner; other sessions require an explicit handoff. Background extraction and consolidation are disabled/paused until configured and resumed. Configure model retry behavior with normal mode and maxRetries=0; the package will not secretly change the host policy.
