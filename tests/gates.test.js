import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check as approval } from '../catalog/hooks/approval-gate/gate.mjs';
import { check as protectedPaths } from '../catalog/hooks/protected-paths/gate.mjs';
import { check as secretGuard } from '../catalog/hooks/secret-guard/gate.mjs';
import { check as testReminder } from '../catalog/hooks/test-reminder/gate.mjs';
import { matchesGlob } from '../catalog/runtime/hooks/runtime.mjs';
import { tmpDir } from './helpers.js';

function context(overrides = {}) {
  let stored = {};
  return {
    runs: overrides.run ? [overrides.run] : [],
    root: '/work/app',
    harness: 'claude',
    now: Date.UTC(2026, 9, 13, 12),
    run: null,
    config: { releaseCommands: [], protectedPaths: [], secretAllow: [], testCommands: [] },
    matchesGlob,
    state: { get: () => stored, set: (value) => (stored = value) },
    ...overrides,
  };
}
const shell = (command) => ({ kind: 'shell', command });
const write = (path, content = '') => ({ kind: 'write', path, content });
const prompt = (text) => ({ kind: 'prompt', text });

describe('approval-gate', () => {
  const activeRun = (overrides = {}) => {
    const dir = join(tmpDir(), '.wishforge/runs/20261013-add-login');
    mkdirSync(dir, { recursive: true });
    return {
      dir,
      name: '20261013-add-login',
      status: 'running',
      stage: 'BUILD',
      approved: false,
      ...overrides,
    };
  };
  const waiting = (overrides = {}) =>
    activeRun({ status: 'waiting for user', stage: 'HUMAN_APPROVAL', ...overrides });

  it('never lets an agent write the approval record', () => {
    for (const ctx of [context(), context({ run: waiting() })]) {
      const result = approval(write('.wishforge/runs/r/09-approval.md', 'decision: approved'), ctx);
      expect(result.block).toContain('09-approval.md');
    }
    expect(approval(write('.wishforge/runs/r/05-build.md'), context())).toBeUndefined();
    expect(approval(write('docs/09-approval.md'), context())).toBeUndefined();
  });

  it('never lets a shell command touch the approval record', () => {
    const result = approval(
      shell('echo "decision: approved" > .wishforge/runs/r/09-approval.md'),
      context()
    );
    expect(result.block).toContain('09-approval.md');
  });

  it.each([
    'git push',
    'git push origin main --force',
    'cd api && git   push',
    'npm publish',
    'pnpm publish --access public',
    'yarn publish',
    'yarn npm publish',
    'gh release create v1.0.0',
    'gh pr merge 12 --squash',
    'docker push registry/app:1',
    'kubectl apply -f k8s/',
    'terraform apply -auto-approve',
    'helm upgrade app ./chart',
    'helm install app ./chart',
    'GIT PUSH',
  ])('blocks "%s" during an unapproved run', (command) => {
    const result = approval(shell(command), context({ run: activeRun() }));
    expect(result.block).toContain('20261013-add-login');
    expect(result.block).toContain('approve');
  });

  it.each([
    'git status',
    'git pull',
    'npm test',
    'npm run publish-docs',
    'echo git pushed',
    'docker build .',
  ])('allows "%s" during an unapproved run', (command) => {
    expect(approval(shell(command), context({ run: activeRun() }))).toBeUndefined();
  });

  it('allows release commands when no run is active or the run is approved', () => {
    expect(approval(shell('git push'), context())).toBeUndefined();
    expect(
      approval(shell('git push'), context({ run: activeRun({ approved: true }) }))
    ).toBeUndefined();
  });

  it('blocks a project-defined release command', () => {
    const ctx = context({ run: activeRun() });
    ctx.config.releaseCommands = [/\bmake\s+deploy\b/i];
    expect(approval(shell('make deploy'), ctx).block).toContain('approve');
    expect(approval(shell('make build'), ctx)).toBeUndefined();
  });

  it.each(['approve', 'Approve', 'APPROVED', '  approve  ', 'approve, ship it', 'approve\nthanks'])(
    'records approval when the user types "%s" at the approval step',
    (text) => {
      const run = waiting();
      const ctx = context({ run, harness: 'codex' });
      const result = approval(prompt(text), ctx);
      expect(result.note).toContain('20261013-add-login');
      const record = readFileSync(join(run.dir, '09-approval.md'), 'utf8').split('\n');
      expect(record[0]).toBe('decision: approved');
      expect(record[1]).toBe('recorded-by: wishforge approval-gate (codex prompt hook)');
      expect(record[2]).toBe('date: 2026-10-13T12:00:00.000Z');
      expect(record[3]).toBe(`user-message: ${text.trim().replace(/\s+/g, ' ')}`);
    }
  );

  it('records approval at the quick flow SHIP step, whatever the case of the stage', () => {
    const run = waiting({ stage: 'ship' });
    expect(approval(prompt('approve'), context({ run })).note).toBeDefined();
  });

  it.each([
    ['there is no run', null],
    ['the run is still running', { status: 'running', stage: 'HUMAN_APPROVAL' }],
    ['the run waits at another stage', { status: 'waiting for user', stage: 'REQUIREMENT' }],
    [
      'the run is already approved',
      { status: 'waiting for user', stage: 'HUMAN_APPROVAL', approved: true },
    ],
  ])('records nothing when %s', (_label, overrides) => {
    const run = overrides ? activeRun(overrides) : null;
    const result = approval(prompt('approve'), context({ run }));
    expect(result?.block).toBeUndefined();
    if (!run || run.approved) expect(result).toBeUndefined();
    else expect(result.note).toContain('was not recorded');
    if (run) expect(existsSync(join(run.dir, '09-approval.md'))).toBe(false);
  });

  it.each(['yes', 'looks good', 'do not approve', 'approvals are pending', 'I approve', ''])(
    'does not treat "%s" as approval',
    (text) => {
      const run = waiting();
      expect(approval(prompt(text), context({ run }))).toBeUndefined();
      expect(existsSync(join(run.dir, '09-approval.md'))).toBe(false);
    }
  );

  it('ignores stop events', () => {
    expect(approval({ kind: 'stop' }, context({ run: activeRun() }))).toBeUndefined();
  });
});

describe('secret-guard', () => {
  // Built by concatenation so this file never contains a literal credential.
  const alnum = (length) =>
    'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zA1bC2dE3fG4hI5'.repeat(3).slice(0, length);
  const samples = [
    ['AWS access key', `AKIA${'ABCDEFGH12345678'}`],
    ['AWS access key', `ASIA${'ABCDEFGH12345678'}`],
    ['GitHub token', `ghp_${alnum(36)}`],
    ['GitHub token', `gho_${alnum(36)}`],
    ['GitHub token', `github_pat_${alnum(30)}`],
    ['Slack token', `xoxb-${'123456789012'}-${alnum(12)}`],
    ['Stripe live key', `sk_live_${alnum(24)}`],
    ['Stripe live key', `rk_live_${alnum(24)}`],
    ['Anthropic API key', `sk-ant-${alnum(40)}`],
    ['OpenAI API key', `sk-${alnum(40)}`],
    ['OpenAI API key', `sk-proj-${alnum(40)}`],
    ['private key', `-----BEGIN ${'RSA'} PRIVATE KEY-----`],
    ['private key', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`],
    ['private key', `-----BEGIN PRIVATE KEY-----`],
  ];

  it.each(samples)('blocks a %s', (kind, secret) => {
    const result = secretGuard(write('src/config.js', `const key = "${secret}";`), context());
    expect(result.block).toContain(kind);
    expect(result.block).toContain('src/config.js');
    expect(result.block).not.toContain(secret);
  });

  it.each([
    ['a short AWS-like id', `AKIA${'ABC'}`],
    ['a public key block', '-----BEGIN PUBLIC KEY-----'],
    ['a certificate block', '-----BEGIN CERTIFICATE-----'],
    ['a Stripe test key', `sk_test_${alnum(24)}`],
    ['a short sk- word', 'sk-short'],
    ['a risk-prefixed word', `risk-${alnum(30)}`],
    ['an environment reference', 'const key = process.env.API_KEY;'],
    ['ordinary code', 'export const token = readToken();'],
    ['empty content', ''],
  ])('allows %s', (_label, content) => {
    expect(secretGuard(write('src/a.js', content), context())).toBeUndefined();
  });

  it('finds a secret on any line', () => {
    const content = ['const a = 1;', `const k = "ghp_${alnum(36)}";`, 'const b = 2;'].join('\n');
    expect(secretGuard(write('a.js', content), context()).block).toContain('GitHub token');
  });

  it('skips a line marked wishforge-allow-secret', () => {
    const line = `const fixture = "ghp_${alnum(36)}"; // wishforge-allow-secret`;
    expect(secretGuard(write('test/fixtures.js', line), context())).toBeUndefined();
    const two = `${line}\nconst real = "ghp_${alnum(36)}";`;
    expect(secretGuard(write('a.js', two), context()).block).toContain('GitHub token');
  });

  it('skips matches a project allows', () => {
    const ctx = context();
    ctx.config.secretAllow = [/EXAMPLE/i];
    expect(secretGuard(write('a.md', `AKIA${'EXAMPLE123456789'}`), ctx)).toBeUndefined();
    expect(secretGuard(write('a.md', `AKIA${'ABCDEFGH12345678'}`), ctx).block).toContain('AWS');
  });

  it('ignores events that are not writes', () => {
    expect(secretGuard(shell(`echo ghp_${alnum(36)}`), context())).toBeUndefined();
    expect(secretGuard(prompt(`my key is ghp_${alnum(36)}`), context())).toBeUndefined();
  });
});

describe('protected-paths', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'api/.env',
    'certs/server.pem',
    'keys/deploy.key',
  ])('blocks a write to %s', (path) => {
    const result = protectedPaths(write(path), context());
    expect(result.block).toContain(path);
    expect(result.block).toContain('protectedPaths');
  });

  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    'api/.env.example',
    'src/env.js',
    'README.md',
  ])('allows a write to %s', (path) => {
    expect(protectedPaths(write(path), context())).toBeUndefined();
  });

  it('blocks project-defined paths and names the pattern', () => {
    const ctx = context();
    ctx.config.protectedPaths = ['migrations/**', 'package-lock.json'];
    expect(protectedPaths(write('migrations/001_init.sql'), ctx).block).toContain('migrations/**');
    expect(protectedPaths(write('web/package-lock.json'), ctx).block).toContain(
      'package-lock.json'
    );
    expect(protectedPaths(write('src/migrations.js'), ctx)).toBeUndefined();
  });

  it('lets a project protect a default-exempt file explicitly', () => {
    const ctx = context();
    ctx.config.protectedPaths = ['.env.example'];
    expect(protectedPaths(write('.env.example'), ctx).block).toContain('.env.example');
  });

  it('handles an absolute path outside the project', () => {
    expect(protectedPaths(write('/home/dev/.env'), context()).block).toContain('/home/dev/.env');
    expect(protectedPaths(write('/etc/hosts'), context())).toBeUndefined();
  });

  it('ignores events that are not writes', () => {
    expect(protectedPaths(shell('cat .env'), context())).toBeUndefined();
  });
});

describe('test-reminder', () => {
  const stop = { kind: 'stop' };

  it('says nothing when a turn ends with no edits', () => {
    expect(testReminder(stop, context())).toBeUndefined();
  });

  it('nudges once when a turn ends with edits and no test run', () => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    expect(testReminder(stop, ctx).note).toContain('tests');
    expect(testReminder(stop, ctx)).toBeUndefined();
    testReminder(write('src/b.js'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it.each([
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test',
    'yarn test',
    'bun test',
    'npx vitest run',
    'npx jest --ci',
    'pytest -q',
    'python -m pytest',
    'go test ./...',
    'cargo test',
    'vendor/bin/phpunit',
    'mvn -q test',
    './gradlew test',
    'dotnet test',
    'bundle exec rspec',
    'make test',
  ])('treats "%s" as a test run', (command) => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    testReminder(shell(command), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('nudges again for new edits after a test run', () => {
    const ctx = context();
    testReminder(write('src/a.js'), ctx);
    testReminder(stop, ctx);
    testReminder(shell('npm test'), ctx);
    testReminder(write('src/b.js'), ctx);
    expect(testReminder(stop, ctx).note).toBeDefined();
  });

  it.each(['npm install', 'git status', 'echo testing', 'npm run build'])(
    'does not treat "%s" as a test run',
    (command) => {
      const ctx = context();
      testReminder(write('src/a.js'), ctx);
      testReminder(shell(command), ctx);
      expect(testReminder(stop, ctx).note).toBeDefined();
    }
  );

  it('ignores edits to documentation and run files', () => {
    const ctx = context();
    testReminder(write('README.md'), ctx);
    testReminder(write('.wishforge/runs/r/state.md'), ctx);
    testReminder(write('.wishforge/runs/r/notes.txt'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('accepts a project-defined test command', () => {
    const ctx = context();
    ctx.config.testCommands = [/\bmake\s+check\b/i];
    testReminder(write('src/a.js'), ctx);
    testReminder(shell('make check'), ctx);
    expect(testReminder(stop, ctx)).toBeUndefined();
  });

  it('never blocks', () => {
    const ctx = context();
    for (const event of [write('src/a.js'), shell('ls'), stop, prompt('hi')]) {
      expect(testReminder(event, ctx)?.block).toBeUndefined();
    }
  });
});
