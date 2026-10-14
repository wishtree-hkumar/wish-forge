---
name: protected-paths
description: Blocks agent writes to files a project marks off-limits, such as environment files, private keys, applied migrations or lockfiles.
events: [write]
---
By default it protects `.env`, `.env.*` and `.envrc`, `*.pem` and `*.key`, and private SSH keys (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`). Templates ending in `.example`, `.sample` or `.template`, such as `.env.local.example`, are not protected, and neither are public keys (`.pub`).

Add your own globs under `protectedPaths` in `.forgeflow/config.json`. A glob with no `/` matches that file name in any folder; `*`, `**` and `?` are supported.

It sees file-writing tools only. A file changed by a shell command is not seen.
