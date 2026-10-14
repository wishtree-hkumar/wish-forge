import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE = [
  /\bgit\s+push\b/i,
  /\b(npm|pnpm)\s+publish\b/i,
  /\byarn\s+(npm\s+)?publish\b/i,
  /\bgh\s+release\s+create\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bdocker\s+push\b/i,
  /\bkubectl\s+apply\b/i,
  /\bterraform\s+apply\b/i,
  /\bhelm\s+(upgrade|install)\b/i,
];
const RECORD = /(^|\/)\.wishforge\/runs\/[^/]+\/09-approval\.md$/i;
const APPROVE = /^approved?$|^approve[\s,.!]/i;
const APPROVAL_STAGE = /human[\s_-]*approval|\bship\b/i;
const HOW = 'A person approves by typing "approve" when the flow asks.';

const atApprovalStep = (run) =>
  run.status.startsWith('waiting for user') && APPROVAL_STAGE.test(run.stage);

export function check(event, ctx) {
  if (event.kind === 'write') {
    if (!RECORD.test(event.path)) return undefined;
    return { block: `wishforge approval-gate: agents may not write 09-approval.md. ${HOW}` };
  }

  if (event.kind === 'shell') {
    if (event.command.toLowerCase().includes('09-approval.md')) {
      return {
        block:
          'wishforge approval-gate: shell commands may not touch 09-approval.md. ' +
          'Read it with your file-reading capability instead.',
      };
    }
    // Any active run without approval gates a release, not only the newest one.
    const pending = ctx.runs.find((run) => !run.approved);
    if (!pending) return undefined;
    const isRelease = [...RELEASE, ...ctx.config.releaseCommands].some((pattern) =>
      pattern.test(event.command)
    );
    if (!isRelease) return undefined;
    return {
      block:
        `wishforge approval-gate: this release command is blocked because flow run ${pending.name} ` +
        `has no recorded human approval. Complete the flow's approval step first. ${HOW} ` +
        `If that run was abandoned, a person can set its status to "stopped" in ` +
        `.wishforge/runs/${pending.name}/state.md.`,
    };
  }

  if (event.kind === 'prompt') {
    const said = event.text.trim();
    if (!APPROVE.test(said)) return undefined;
    const open = ctx.runs.filter((run) => !run.approved);
    if (open.length === 0) return undefined;

    const run = open.find(atApprovalStep);
    if (!run) {
      const [latest] = open;
      return {
        note:
          `wishforge approval-gate: "approve" was not recorded. Run ${latest.name} is not waiting ` +
          `at its approval step: its state.md has status "${latest.status}" and current stage ` +
          `"${latest.stage}". Before asking for approval, the flow must set status to ` +
          '"waiting for user" and current stage to HUMAN_APPROVAL or SHIP.',
      };
    }

    const record = [
      'decision: approved',
      `recorded-by: wishforge approval-gate (${ctx.harness} prompt hook)`,
      `date: ${new Date(ctx.now).toISOString()}`,
      `user-message: ${said.replace(/\s+/g, ' ')}`,
      '',
    ].join('\n');
    writeFileSync(join(run.dir, '09-approval.md'), record);
    return { note: `wishforge: human approval recorded for run ${run.name} in 09-approval.md.` };
  }

  return undefined;
}
