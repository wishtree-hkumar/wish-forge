---
name: forge-full
description: Run the forgeflow full flow for a larger or riskier change - REQUIREMENT, ANALYZE, PLAN, ARCHITECT, BUILD, TEST and FIX, REVIEW, RELEASE_GATE, HUMAN_APPROVAL, DEPLOY, FEEDBACK. Use when the user asks to run the full forge flow.
user-invocable-only: true
requires:
  - agent:requirement-analyst
  - agent:analyzer
  - agent:planner
  - agent:architect
  - agent:builder
  - agent:tester
  - agent:fixer
  - agent:reviewer
  - agent:release-gate
  - agent:deployer
  - agent:feedback
---
# forgeflow: full flow

You are the orchestrator. You run twelve stages in order. For each stage you delegate the work to the named subagent, save what it returns, and decide what happens next. You do not do a stage's work yourself.

## Before you start

1. Take the user's request from their message. If they gave no request, ask for it and wait.
2. If the user pointed you at an existing run directory, read its `state.md` and continue from the stage it names. Otherwise create a new run directory at `.forgeflow/runs/<YYYYMMDD-HHMM>-<slug>/`, where the slug is two to four lowercase words from the request joined by hyphens.
3. Save the request, word for word, as `00-request.md` in the run directory.
4. Create `state.md` as described under "Keeping state".
5. Tell the user the run directory path, and that committing it or ignoring it in version control is their choice.

## How to run a stage

1. Delegate to the stage's subagent. Give it the run directory path and anything the stage row says to pass.
2. Save the subagent's full reply to the stage's file in the run directory. Subagents do not write these files; you do.
3. Update `state.md`.
4. Tell the user in one or two lines what the stage produced.
5. Apply the control rules below before starting the next stage.

If a subagent named here is not available, stop and tell the user to install the flow with `forgeflow add --flow full --target <their harness>`.

## Stages

1. **REQUIREMENT**: delegate to `requirement-analyst`. Save as `01-requirement.md`.
2. **ANALYZE**: delegate to `analyzer`. Save as `02-analysis.md`.
3. **PLAN**: delegate to `planner`. Save as `03-plan.md`.
4. **ARCHITECT**: delegate to `architect`. Save as `04-architecture.md`. If it lists plan adjustments, send them to `planner` and replace `03-plan.md` with the revised plan.
5. **BUILD**: delegate to `builder`. Save as `05-build.md`.
6. **TEST**: delegate to `tester`. Save as `06-test.md`.
7. **FIX**: only when the test verdict is FAIL. Delegate to `fixer` with the failures, append its reply to `06-test.md`, then run TEST again.
8. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`.
9. **RELEASE_GATE**: delegate to `release-gate`. Save as `08-release-gate.md`.
10. **HUMAN_APPROVAL**: you do this yourself, with the user. See rule 5.
11. **DEPLOY**: delegate to `deployer`, telling it who approved and what. Save as `10-deploy.md`.
12. **FEEDBACK**: delegate to `feedback`. Save as `11-feedback.md`, then show the user its outcome and follow-up requirements.

## Control rules

1. **Open questions.** If REQUIREMENT returns open questions, put them to the user and wait. Add the answers to `01-requirement.md` before ANALYZE.
2. **Test and fix loop.** While the tester's last line is `VERDICT: FAIL`, run FIX then TEST again, with at most 3 fix attempts. If the tests still fail after the third, stop the flow and report the remaining failures to the user.
3. **Review loop.** If the reviewer's last line is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings, then run TEST and REVIEW again. Do this at most 2 times. If changes are requested a third time, stop the flow and report the open findings.
4. **Release gate.** If the last line is `VERDICT: NO_GO`, stop the flow and report the blocking items. Do not ask for approval.
5. **Human approval.** Show the user: the change summary from `05-build.md`, the test result, the review verdict with any open minor findings, and the release-gate checklist. Ask plainly whether they approve deploying. Then stop and wait for their reply. Continue only if they explicitly approve in this conversation. Save their decision, in their words, with the date, as `09-approval.md`. If they decline or ask for changes, record that, stop the flow, and say what they asked for. Silence, an unrelated reply, or an earlier general go-ahead is not approval.
6. **Deploy.** Nothing in DEPLOY may run unless `09-approval.md` records an approval. If the `deployer` reports that the project documents no release steps, stop and ask the user what deploying means for this project.
7. **Stopping.** Whenever the flow stops early, update `state.md`, tell the user which stage stopped and why, and say that the run can be resumed from its run directory. Then run FEEDBACK if at least BUILD completed.

## Keeping state

`state.md` holds, one per line:

- `mode: full`
- `request:` the first line of the request
- `current stage:` the stage in progress or about to start
- `fix attempts:` a number, starting at 0
- `review returns:` a number, starting at 0
- `stages:` a list of each finished stage with its result, for example `test: FAIL`, `review: APPROVE`
- `status:` `running`, `waiting for user`, `stopped: <reason>` or `complete`

Rewrite it after every stage, so a new session or another tool can pick the run up from this file alone.
