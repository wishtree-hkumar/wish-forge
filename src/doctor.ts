import { loadCatalog } from './catalog';
import { status } from './ops';
import type { TargetStatus } from './ops';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function problemsOf(targets: TargetStatus[]): string[] {
  return targets.flatMap((target) => {
    const files = target.items.flatMap((entry) =>
      entry.files
        .filter((file) => file.state !== 'ok')
        .map((file) => `[${target.target}] ${file.path} is ${file.state}`)
    );
    const { wiring, rules } = target;
    if (wiring && wiring.state !== 'ok') {
      files.push(`[${target.target}] hook wiring in ${wiring.path} is ${wiring.state}`);
    }
    if (rules && rules.state !== 'ok') {
      files.push(`[${target.target}] rules wiring in ${rules.path} is ${rules.state}`);
    }
    return files;
  });
}

export function runDoctor({
  catalogDir,
  cwd,
  home,
  nodeVersion = process.versions.node,
}: {
  catalogDir: string;
  cwd: string;
  home: string;
  nodeVersion?: string;
}): Check[] {
  const checks: Check[] = [];

  const major = Number(nodeVersion.split('.')[0]);
  checks.push({ name: 'Node.js >= 20', ok: major >= 20, detail: `found ${nodeVersion}` });

  try {
    const catalog = loadCatalog(catalogDir);
    checks.push({ name: 'catalog is valid', ok: true, detail: `${catalog.size} items` });
  } catch (error) {
    checks.push({ name: 'catalog is valid', ok: false, detail: (error as Error).message });
  }

  let codexHasGates = false;
  for (const scope of ['project', 'global'] as const) {
    const name = `${scope} install matches lockfile`;
    try {
      const targets = status({ scope, cwd, home });
      const problems = problemsOf(targets);
      const detail = problems.length > 0 ? problems.join('; ') : 'no differences';
      checks.push({ name, ok: problems.length === 0, detail });
      codexHasGates ||= targets.some((target) => target.target === 'codex' && target.wiring);
    } catch (error) {
      checks.push({ name, ok: false, detail: (error as Error).message });
    }
  }

  if (codexHasGates) {
    checks.push({
      name: 'codex hooks need trusting',
      ok: true,
      detail: 'wishforge cannot check this: run /hooks in Codex to review and trust them',
    });
  }
  return checks;
}
