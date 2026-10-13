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

If a subagent that a stage names is not available, stop and tell the user to install the flow with `forgeflow add --flow full --target <their harness>`. The review specialists are optional: see "Review specialists".

## Stages

1. **REQUIREMENT**: delegate to `requirement-analyst`. Save as `01-requirement.md`.
2. **ANALYZE**: delegate to `analyzer`. Save as `02-analysis.md`.
3. **PLAN**: delegate to `planner`. Save as `03-plan.md`.
4. **ARCHITECT**: delegate to `architect`. Save as `04-architecture.md`. If it lists plan adjustments, send them to `planner` and replace `03-plan.md` with the revised plan.
5. **BUILD**: delegate to `builder`. Save as `05-build.md`.
6. **TEST**: delegate to `tester`. Save as `06-test.md`.
7. **FIX**: only when the test verdict is FAIL. Delegate to `fixer` with the failures, append its reply to `06-test.md`, then run TEST again.
8. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`. Then run the installed review specialists, as "Review specialists" describes.
9. **RELEASE_GATE**: delegate to `release-gate`. Save as `08-release-gate.md`.
10. **HUMAN_APPROVAL**: you do this yourself, with the user. See rule 5.
11. **DEPLOY**: delegate to `deployer`, telling it who approved and what. Save as `10-deploy.md`.
12. **FEEDBACK**: delegate to `feedback`. Save as `11-feedback.md`, then show the user its outcome and follow-up requirements.

## Review specialists

Four optional agents each review one subject: `security-reviewer`, `performance-reviewer`, `database-reviewer` and `accessibility-reviewer`. The flow works without them.

At REVIEW, after `reviewer`:

1. List the files in `{{agents-dir}}` in the project and in `{{global-agents-dir}}`. A specialist is installed when a file named for it, with any extension, is in either folder.
2. Delegate to each installed specialist, in the order above, giving it the run directory path. Save each full reply as `07-review-<agent name>.md`, for example `07-review-security-reviewer.md`.
3. Skip a specialist that is not installed. Do not mention it, and do not ask the user to install it.
4. Record each verdict in the `stages` list in `state.md`, for example `security-reviewer: APPROVE`.

Collect every verdict before you apply rule 3.

## Control rules

1. **Open questions.** If REQUIREMENT returns open questions, put them to the user and wait. Add the answers to `01-requirement.md` before ANALYZE.
2. **Test and fix loop.** While the tester's last line is `VERDICT: FAIL`, run FIX then TEST again, with at most 3 fix attempts. If the tests still fail after the third, stop the flow and report the remaining failures to the user.
3. **Review loop.** If the last line from `reviewer`, or from any review specialist that ran, is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings of everyone who requested changes, then run TEST and REVIEW again, including every installed specialist. Each new reply replaces that reviewer's file. Do this at most 2 times, counting rounds, not reviewers. If changes are requested a third time, stop the flow and report the open findings.
4. **Release gate.** If the last line is `VERDICT: NO_GO`, stop the flow and report the blocking items. Do not ask for approval.
5. **Human approval.** Set `status: waiting for user` and `current stage: HUMAN_APPROVAL` in `state.md`. Show the user: the change summary from `05-build.md`, the test result, each review verdict, the reviewer's and every specialist's, with any open minor findings, and the release-gate checklist. Ask them to reply with exactly `approve` to approve deploying, or to say what they want changed. Then stop and wait for their reply. After they reply, read `09-approval.md`. If it contains the line `decision: approved`, the approval is recorded: continue. If the file does not exist and their reply clearly approves, save their decision, in their words, with the date, as `09-approval.md`; if you are blocked from writing that file, an approval gate is installed, so ask the user to reply with exactly `approve`. If that reply is still not recorded, check that `state.md` has `status: waiting for user` and the `current stage` line written exactly as above, correct it, and ask again. If they decline or ask for changes, record that in `state.md`, stop the flow, and say what they asked for. Silence, an unrelated reply, or an earlier general go-ahead is not approval.
6. **Deploy.** Nothing in DEPLOY may run unless `09-approval.md` records an approval. If the `deployer` reports that the project documents no release steps, stop and ask the user what deploying means for this project.
7. **Stopping.** Whenever the flow stops early, update `state.md`, tell the user which stage stopped and why, and say that the run can be resumed from its run directory. Then run FEEDBACK if at least BUILD completed.
8. **Fail closed.** If a subagent's reply lacks the verdict line its stage requires, or the subagent reports that it stopped or could not finish its work, stop the flow and report what it said. This covers the review specialists: if one is installed and cannot be delegated to or returns no verdict line, stop. Never treat a missing verdict as a pass.

## Keeping state

`state.md` holds these lines. Write each exactly as `key: value`, with no bullets, backticks or other formatting, so that tools can read it:

- `mode: full`
- `request:` the first line of the request
- `current stage:` the stage in progress or about to start
- `fix attempts:` a number, starting at 0
- `review returns:` a number, starting at 0
- `stages:` a list of each finished stage with its result, for example `test: FAIL`, `review: APPROVE`
- `status:` `running`, `waiting for user`, `stopped: <reason>` or `complete`

Rewrite it after every stage, so a new session or another tool can pick the run up from this file alone.
