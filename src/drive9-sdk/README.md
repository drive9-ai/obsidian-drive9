# Drive9 SDK Adapter

This directory contains the Obsidian-compatible subset of `mem9-ai/drive9`'s TypeScript SDK (`clients/drive9-js`, package version `0.1.3`).

The published SDK package is Node-oriented and imports Node modules such as `fs` and `path` from its main entrypoint. Obsidian plugins must run on desktop and mobile, so this adapter preserves the SDK request/transfer semantics while using Obsidian's `requestUrl` transport.

Keep this directory in sync with upstream SDK changes when updating Drive9 protocol support.
