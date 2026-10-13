---
name: protected-paths
description: Blocks agent writes to files a project marks off-limits, such as environment files, private keys, applied migrations or lockfiles.
events: [write]
---
By default it protects `.env` and `.env.*` (but not `.env.example`, `.env.sample` or `.env.template`), `*.pem` and `*.key`.

Add your own globs under `protectedPaths` in `.forgeflow/config.json`. A glob with no `/` matches that file name in any folder; `*`, `**` and `?` are supported.

It sees file-writing tools only. A file changed by a shell command is not seen.
