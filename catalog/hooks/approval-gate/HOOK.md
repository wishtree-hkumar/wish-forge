---
name: approval-gate
description: Blocks release commands during a forgeflow run until a person types approve, and records that approval itself so the model cannot.
events: [shell, write, prompt]
---
While a forgeflow run is in progress and has no recorded approval, this gate blocks agent-issued release commands: `git push`, `npm publish`, `pnpm publish`, `yarn publish`, `gh release create`, `gh pr merge`, `docker push`, `kubectl apply`, `terraform apply`, `helm upgrade` and `helm install`. Add your own under `releaseCommands` in `.forgeflow/config.json`.

When the flow reaches its approval step and you type `approve`, the gate writes `09-approval.md` in the run folder. Agents are blocked from writing that file or naming it in a shell command.

Outside a run, nothing is blocked. A run that has been idle for 24 hours no longer gates.
