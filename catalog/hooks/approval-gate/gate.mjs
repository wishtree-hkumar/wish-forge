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
const RECORD = /(^|\/)\.forgeflow\/runs\/[^/]+\/09-approval\.md$/;
const APPROVE = /^approved?$|^approve[\s,.!]/i;
const APPROVAL_STAGES = new Set(['human_approval', 'ship']);
const HOW = 'A person approves by typing "approve" when the flow asks.';

export function check(event, ctx) {
  if (event.kind === 'write') {
    if (!RECORD.test(event.path)) return undefined;
    return { block: `forgeflow approval-gate: agents may not write 09-approval.md. ${HOW}` };
  }

  if (event.kind === 'shell') {
    if (event.command.includes('09-approval.md')) {
      return {
        block:
          'forgeflow approval-gate: shell commands may not touch 09-approval.md. ' +
          'Read it with your file-reading capability instead.',
      };
    }
    const run = ctx.run;
    if (!run || run.approved) return undefined;
    const isRelease = [...RELEASE, ...ctx.config.releaseCommands].some((pattern) =>
      pattern.test(event.command)
    );
    if (!isRelease) return undefined;
    return {
      block:
        `forgeflow approval-gate: this release command is blocked because flow run ${run.name} ` +
        `has no recorded human approval. Complete the flow's approval step first. ${HOW}`,
    };
  }

  if (event.kind === 'prompt') {
    const run = ctx.run;
    const said = event.text.trim();
    if (!run || run.approved || !APPROVE.test(said)) return undefined;
    const atApprovalStep =
      run.status.startsWith('waiting for user') && APPROVAL_STAGES.has(run.stage.toLowerCase());
    if (!atApprovalStep) return undefined;

    const record = [
      'decision: approved',
      `recorded-by: forgeflow approval-gate (${ctx.harness} prompt hook)`,
      `date: ${new Date(ctx.now).toISOString()}`,
      `user-message: ${said.replace(/\s+/g, ' ')}`,
      '',
    ].join('\n');
    writeFileSync(join(run.dir, '09-approval.md'), record);
    return { note: `forgeflow: human approval recorded for run ${run.name} in 09-approval.md.` };
  }

  return undefined;
}
