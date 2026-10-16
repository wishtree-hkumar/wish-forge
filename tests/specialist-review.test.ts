import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog';

const catalog = loadCatalog(fileURLToPath(new URL('../catalog', import.meta.url)));
const body = (id) => catalog.get(id).body;
const REVIEWERS = [
  'security-reviewer',
  'performance-reviewer',
  'database-reviewer',
  'accessibility-reviewer',
];

describe('review fixes', () => {
  it('refactorer undoes its own edit and never discards uncommitted work', () => {
    const text = body('agent:refactorer');
    expect(text).toContain('already have uncommitted changes');
    expect(text).toContain('undo it by reversing your own edit');
    expect(text).toContain(
      'Do not use version-control commands that discard uncommitted work (restore, checkout, reset, stash, clean).'
    );
  });

  it('debugger carries on by reading when it is not allowed to run the failure', () => {
    const text = body('agent:debugger');
    expect(text).toContain('If you are not allowed to run it');
    expect(text).toContain('label the cause as unconfirmed');
  });

  it.each(REVIEWERS)('%s still ends with a verdict line when nothing is in scope', (name) => {
    expect(body(`agent:${name}`)).toContain(
      'If the change does not touch your subject, say so in one line and end with `VERDICT: APPROVE`.'
    );
  });

  it.each(['forge-quick', 'forge-full'])('%s copes with a missing or unreadable folder', (flow) => {
    const text = body(`skill:${flow}`);
    expect(text).toContain('A folder that does not exist has no specialists.');
    expect(text).toContain('If you cannot read a folder, tell the user which one in one line');
  });

  it('release-gate holds specialist reports to the same bar as the review', () => {
    expect(body('agent:release-gate')).toContain(
      'each of them must end in `VERDICT: APPROVE` too, with no open blocker or major finding'
    );
  });

  it('the manual checks cover the debugger under a read-only sandbox', () => {
    const checks = readFileSync(
      fileURLToPath(new URL('../docs/verification.md', import.meta.url)),
      'utf8'
    );
    expect(checks).toMatch(/^\| 31 \|.*`debugger`/m);
  });
});
