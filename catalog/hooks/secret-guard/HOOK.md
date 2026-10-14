---
name: secret-guard
description: Blocks a file write whose new text contains a credential in a known format, such as a cloud access key, an API token or a private key.
events: [write]
---
Checks the text an agent is about to write. It recognizes AWS access key ids, GitHub tokens, Slack tokens, Stripe live keys, Anthropic and OpenAI API keys, and PEM private key headers.

It matches known formats only. It does not guess at passwords, so it stays quiet on ordinary code. Google API keys are not matched, because Firebase web keys share their format and are public by design.

To allow a false positive, add `wishforge-allow-secret` to that line, or add a pattern under `secretAllow` in `.wishforge/config.json`.

It sees file-writing tools only. A secret written by a shell command is not seen.
