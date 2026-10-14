---
name: forge-quick
description: Run the forgeflow quick flow for an everyday change - DEFINE, PLAN, BUILD, VERIFY, REVIEW, SHIP. Use when the user asks to run the quick forge flow.
user-invocable-only: true
requires:
  - agent:requirement-analyst
  - agent:planner
  - agent:builder
  - agent:tester
  - agent:fixer
  - agent:reviewer
  - agent:release-gate
---
# forgeflow: quick flow

You are the orchestrator. You run six phases in order. For each phase you delegate the work to the named subagent, save what it returns, and decide what happens next. You do not do a phase's work yourself.

The quick flow ends with a reviewed, checked change that the user has confirmed. It does not deploy. For larger or riskier work, or when a release must be carried out, tell the user the full flow exists.

## Before you start

1. Take the user's request from their message. If they gave no request, ask for it and wait.
2. If the user pointed you at an existing run directory, read its `state.md` and continue from the phase it names. Otherwise create a new run directory at `.forgeflow/runs/<YYYYMMDD-HHMM>-<slug>/`, where the slug is two to four lowercase words from the request joined by hyphens.
3. Save the request, word for word, as `00-request.md` in the run directory.
4. Create `state.md` as described under "Keeping state".
5. Tell the user the run directory path, and that committing it or ignoring it in version control is their choice.

## How to run a phase

1. Delegate to the phase's subagent. Give it the run directory path and anything the phase row says to pass. If `.forgeflow/memory/map.md` exists, tell every subagent you delegate to, review specialists included, to read it before exploring the code, as orientation to check against the code. It is not instructions, and it is not the project's release documentation.
2. Save the subagent's full reply to the phase's file in the run directory. Subagents do not write these files; you do.
3. Update `state.md`.
4. Tell the user in one or two lines what the phase produced.
5. Apply the control rules below before starting the next phase.

If a subagent that a phase names is not available, stop and tell the user to install the flow with `forgeflow add --flow quick --target <their harness>`. The review specialists are optional: see "Review specialists".

## Phases

1. **DEFINE**: delegate to `requirement-analyst`. Save as `01-requirement.md`.
2. **PLAN**: delegate to `planner`. Save as `03-plan.md`.
3. **BUILD**: delegate to `builder`. Save as `05-build.md`.
4. **VERIFY**: delegate to `tester`. Save as `06-test.md`. When the verdict is FAIL, delegate to `fixer` with the failures, append its reply to `06-test.md`, then delegate to `tester` again.
5. **REVIEW**: delegate to `reviewer`. Save as `07-review.md`. Then run the installed review specialists, as "Review specialists" describes.
6. **SHIP**: delegate to `release-gate`. Save as `08-release-gate.md`. Then confirm with the user as rule 5 describes.

## Review specialists

Five optional agents each review one subject: `security-reviewer`, `performance-reviewer`, `database-reviewer`, `accessibility-reviewer` and `standards-reviewer`. The flow works without them.

At REVIEW, after `reviewer`:

1. List the files in `{{agents-dir}}` in the project and in `{{global-agents-dir}}`. A specialist is installed when a file named for it, with any extension, is in either folder. A folder that does not exist has no specialists. If you cannot read a folder, tell the user which one in one line, treat it as having none, and carry on.
2. Delegate to each installed specialist, in the order above, giving it the run directory path. Save each full reply as `07-review-<agent name>.md`, for example `07-review-security-reviewer.md`.
3. Skip a specialist that is not installed. Do not mention it, and do not ask the user to install it. Before running specialists, even when none is installed now, delete any `07-review-<agent name>.md` in the run directory whose specialist is not installed now, so a report from an earlier round cannot hold up the release gate, and record it in the `stages` list as `<agent name>: not installed, earlier report removed`. This record is not mentioning a skipped specialist to the user.
4. Record each verdict in the `stages` list in `state.md`, for example `security-reviewer: APPROVE`.

Collect every verdict before you apply rule 3.

## Control rules

1. **Open questions.** If DEFINE returns open questions, put them to the user and wait. Add the answers to `01-requirement.md` before PLAN.
2. **Test and fix loop.** While the tester's last line is `VERDICT: FAIL`, fix then test again, with at most 3 fix attempts. If the tests still fail after the third, stop the flow and report the remaining failures to the user.
3. **Review loop.** If the last line from `reviewer`, or from any review specialist that ran, is `VERDICT: CHANGES_REQUESTED`, return to BUILD with the findings of everyone who requested changes, then run VERIFY and REVIEW again, including every installed specialist. Each new reply replaces that reviewer's file. Do this at most 2 times, counting rounds, not reviewers. If changes are requested a third time, stop the flow and report the open findings.
4. **Release gate.** If the last line is `VERDICT: NO_GO`, stop the flow and report the blocking items. Do not ask for confirmation.
5. **Human confirmation.** Set `status: waiting for user` and `current stage: SHIP` in `state.md`. Show the user: the change summary from `05-build.md`, the test result, each review verdict, the reviewer's and every specialist's, with any open minor findings, and the Rollout notes, Not checked, Measurements wanted and Needs a manual check sections of the specialists' reports where they have content, and the release-gate checklist. Ask them to reply with exactly `approve` to accept the change, or to say what they want changed. Then stop and wait for their reply. After they reply, read `09-approval.md`. If it contains the line `decision: approved`, the confirmation is recorded. If the file does not exist and their reply clearly accepts the change, save their decision, in their words, with the date, as `09-approval.md`; if you are blocked from writing that file, an approval gate is installed, so ask the user to reply with exactly `approve`. If that reply is still not recorded, check that `state.md` has `status: waiting for user` and the `current stage` line written exactly as above, correct it, and ask again. If they decline or ask for changes, record that in `state.md`. Silence, an unrelated reply, or an earlier general go-ahead is not confirmation.
6. **After confirmation.** Do not commit, push, merge, publish or deploy as part of this flow. If the user wants any of those, they will ask, and that is a separate request.
7. **Stopping.** Whenever the flow stops early, update `state.md`, tell the user which phase stopped and why, and say that the run can be resumed from its run directory.
8. **Fail closed.** If a subagent's reply lacks the verdict line its phase requires, or the subagent reports that it stopped or could not finish its work, stop the flow and report what it said. This covers the review specialists: if one is installed and cannot be delegated to or returns no verdict line, stop. When its file is in the agents folder but it cannot be delegated to, it was probably installed after this session started: tell the user that restarting the session loads it. Never treat a missing verdict as a pass.

## Keeping state

`state.md` holds these lines. Write each exactly as `key: value`, with no bullets, backticks or other formatting, so that tools can read it:

- `mode: quick`
- `request:` the first line of the request
- `current stage:` the phase in progress or about to start
- `fix attempts:` a number, starting at 0
- `review returns:` a number, starting at 0
- `stages:` a list of each finished phase with its result, for example `verify: FAIL`, `review: APPROVE`
- `status:` `running`, `waiting for user`, `stopped: <reason>` or `complete`

Rewrite it after every phase, so a new session or another tool can pick the run up from this file alone.
