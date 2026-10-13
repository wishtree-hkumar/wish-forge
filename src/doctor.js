import { loadCatalog } from './catalog.js';
import { status } from './ops.js';

export function runDoctor({ catalogDir, cwd, home, nodeVersion = process.versions.node }) {
  const checks = [];

  const major = Number(nodeVersion.split('.')[0]);
  checks.push({ name: 'Node.js >= 20', ok: major >= 20, detail: `found ${nodeVersion}` });

  try {
    const catalog = loadCatalog(catalogDir);
    checks.push({ name: 'catalog is valid', ok: true, detail: `${catalog.size} items` });
  } catch (error) {
    checks.push({ name: 'catalog is valid', ok: false, detail: error.message });
  }

  for (const scope of ['project', 'global']) {
    const name = `${scope} install matches lockfile`;
    try {
      const problems = status({ scope, cwd, home }).flatMap((target) =>
        target.items.flatMap((entry) =>
          entry.files
            .filter((file) => file.state !== 'ok')
            .map((file) => `[${target.target}] ${file.path} is ${file.state}`)
        )
      );
      const detail = problems.length > 0 ? problems.join('; ') : 'no differences';
      checks.push({ name, ok: problems.length === 0, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  }
  return checks;
}
