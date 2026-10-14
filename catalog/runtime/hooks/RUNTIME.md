---
name: hooks
description: Runner that translates harness hook input into neutral events and calls each installed wishforge gate.
---
Installed automatically with any wishforge gate, and removed with the last one.

The runner reads the harness's hook input, turns it into `shell`, `write`, `prompt` and `stop` events, and passes each to every gate in the `gates/` folder beside it. The first gate that blocks wins.

It has no dependencies beyond Node 20. If it fails, the action it was checking proceeds.
