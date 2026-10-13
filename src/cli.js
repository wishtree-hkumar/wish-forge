import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAdapter, targetNames } from './adapters/index.js';
import { loadCatalog } from './catalog.js';
import { runDoctor } from './doctor.js';
import { ConflictError, UsageError } from './errors.js';
import { add, remove, status, update } from './ops.js';
import { findId } from './resolve.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog', import.meta.url));
const LISTED_TYPES = ['agent', 'skill', 'hook', 'rule'];

const USAGE = `Usage:
  forgeflow list [--type agent|skill|hook|rule] [--json]
  forgeflow info <id>
  forgeflow add <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow add --flow quick|full --target <t>[,<t>...]
  forgeflow add --hooks --target <t>[,<t>...]
  forgeflow add --specialists --target <t>[,<t>...] [--global]
  forgeflow add --memory --target <t>[,<t>...]
  forgeflow remove <id...> --target <t>[,<t>...] [--global] [--dry-run] [--force]
  forgeflow update [<id...>] [--target <t>[,<t>...]] [--global] [--dry-run] [--force]
  forgeflow status [--global]
  forgeflow doctor

Targets: ${targetNames.join(', ')}
An <id> is a name such as "reviewer", or a full id such as "agent:reviewer".
--hooks installs every quality gate. Gates are installed per project only.
--specialists installs every agent that is not a flow stage.
--memory installs session memory and the project map. Per project only.
A rule is a pack of coding standards, such as "common" or "typescript".
`;

const OPTIONS = {
  target: { type: 'string' },
  flow: { type: 'string' },
  type: { type: 'string' },
  hooks: { type: 'boolean' },
  specialists: { type: 'boolean' },
  memory: { type: 'boolean' },
  global: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const LABELS = {
  skip: 'unchanged',
  keep: 'kept',
  missing: 'already gone',
  wire: 'wired',
  unwire: 'unwired',
  manual: 'by hand',
};
const NOTHING = 'Nothing is installed here.\n';

function parseTargets(value, required) {
  if (value === undefined) {
    if (!required) return undefined;
    throw new UsageError(`--target is required. Choose from: ${targetNames.join(', ')}.`);
  }
  const names = [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  if (names.length === 0) {
    throw new UsageError(`--target names no harness. Choose from: ${targetNames.join(', ')}.`);
  }
  names.forEach(getAdapter);
  return names;
}

function printResult(stdout, { plans, skipped }, dryRun) {
  for (const { target, root, actions } of plans) {
    stdout.write(`${target}  (${root})\n`);
    for (const { type, path, reason } of actions) {
      const label = (LABELS[type] ?? type).padEnd(12);
      stdout.write(`  ${label} ${path}${reason ? `  (${reason})` : ''}\n`);
    }
  }
  for (const { target, id } of skipped) {
    stdout.write(`[${target}] ${id} is no longer in the catalog; left as installed.\n`);
  }
  if (dryRun) stdout.write('Dry run: nothing was written.\n');
}

function printStatus(stdout, targets) {
  if (targets.length === 0) {
    stdout.write(NOTHING);
    return;
  }
  for (const { target, root, items, wiring, rules } of targets) {
    stdout.write(`${target}  (${root})\n`);
    for (const { id, explicit, files } of items) {
      stdout.write(`  ${id}${explicit ? '' : '  (required)'}\n`);
      for (const { path, state } of files) stdout.write(`    ${state.padEnd(8)} ${path}\n`);
    }
    if (wiring) stdout.write(`  ${`wiring ${wiring.state}`.padEnd(17)} ${wiring.path}\n`);
    if (rules) stdout.write(`  ${`rules ${rules.state}`.padEnd(17)} ${rules.path}\n`);
  }
}

function run(argv, { cwd, home, stdout, stderr, catalogDir = DEFAULT_CATALOG }) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const [command, ...refs] = positionals;

  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    stderr.write(USAGE);
    return 2;
  }

  if (command === 'doctor') {
    const checks = runDoctor({ catalogDir, cwd, home });
    for (const { name, ok, detail } of checks) {
      stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name} (${detail})\n`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }

  const catalog = loadCatalog(catalogDir);
  const ctx = {
    catalog,
    version: VERSION,
    scope: values.global ? 'global' : 'project',
    cwd,
    home,
    force: Boolean(values.force),
    dryRun: Boolean(values['dry-run']),
  };

  switch (command) {
    case 'list': {
      if (values.type !== undefined && !LISTED_TYPES.includes(values.type)) {
        throw new UsageError(`--type must be one of: ${LISTED_TYPES.join(', ')}.`);
      }
      // The runtime is installed only as a requirement, so it is not offered.
      const items = [...catalog.values()]
        .filter((item) => LISTED_TYPES.includes(item.type))
        .filter((item) => values.type === undefined || item.type === values.type)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (values.json) {
        const rows = items.map(
          ({
            id,
            type,
            name,
            description,
            stage,
            joins,
            group,
            access,
            modelTier,
            events,
            paths,
            requires,
          }) => ({
            id,
            type,
            name,
            description,
            stage,
            joins,
            group,
            access,
            modelTier,
            events,
            paths,
            requires,
          })
        );
        stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const item of items) {
          const none = { agent: 'specialist', rule: 'rule' }[item.type] ?? '-';
          const stage = (item.stage ?? item.events?.join(',') ?? none).padEnd(13);
          const access = (item.access ?? '-').padEnd(10);
          stdout.write(`${item.id.padEnd(28)} ${stage} ${access} ${item.description}\n`);
        }
      }
      return 0;
    }

    case 'info': {
      if (refs.length !== 1) throw new UsageError('info takes exactly one item id.');
      const item = catalog.get(findId(catalog, refs[0]));
      const rows = [
        ['id', item.id],
        ['description', item.description],
        ['stage', item.stage],
        ['joins', item.joins],
        ['group', item.group],
        ['access', item.access],
        ['model tier', item.modelTier],
        ['events', item.events?.join(', ')],
        ['paths', item.type === 'rule' ? (item.paths?.join(', ') ?? 'all work') : undefined],
        ['requires', item.requires.join(', ') || 'nothing'],
      ];
      for (const [label, value] of rows) {
        if (value !== undefined) stdout.write(`${`${label}:`.padEnd(13)} ${value}\n`);
      }
      return 0;
    }

    case 'add': {
      const wanted = [...refs];
      if (values.flow !== undefined) {
        if (!['quick', 'full'].includes(values.flow)) {
          throw new UsageError('--flow must be quick or full.');
        }
        wanted.push(`skill:forge-${values.flow}`);
      }
      if (values.hooks) {
        // A hook in a group belongs to that group's bundle, not to the gates.
        const gates = [...catalog.values()].filter(
          (item) => item.type === 'hook' && item.group === undefined
        );
        wanted.push(...gates.map((item) => item.id).sort());
      }
      if (values.specialists) {
        const specialists = [...catalog.values()].filter(
          (item) => item.type === 'agent' && item.stage === undefined
        );
        wanted.push(...specialists.map((item) => item.id).sort());
      }
      if (values.memory) {
        const memory = [...catalog.values()].filter((item) => item.group === 'memory');
        wanted.push(...memory.map((item) => item.id).sort());
      }
      if (wanted.length === 0) {
        throw new UsageError(
          'name at least one item, or use --flow quick|full, --hooks, --specialists or --memory.'
        );
      }
      printResult(stdout, add(ctx, wanted, parseTargets(values.target, true)), ctx.dryRun);
      return 0;
    }

    case 'remove': {
      if (refs.length === 0) throw new UsageError('name at least one item to remove.');
      printResult(stdout, remove(ctx, refs, parseTargets(values.target, true)), ctx.dryRun);
      return 0;
    }

    case 'update': {
      const result = update(ctx, refs, parseTargets(values.target, false));
      if (result.plans.length === 0) stdout.write(NOTHING);
      else printResult(stdout, result, ctx.dryRun);
      return 0;
    }

    case 'status':
      printStatus(stdout, status(ctx));
      return 0;

    default:
      throw new UsageError(`unknown command "${command}". Run "forgeflow --help".`);
  }
}

export function main(argv, io) {
  try {
    return run(argv, io);
  } catch (error) {
    if (error instanceof ConflictError) {
      io.stderr.write(`forgeflow: ${error.message}:\n`);
      for (const { target, path, reason } of error.conflicts) {
        io.stderr.write(`  [${target}] ${path} (${reason})\n`);
      }
      io.stderr.write('Nothing was written. Re-run with --force to overwrite these files.\n');
      return 1;
    }
    io.stderr.write(`forgeflow: ${error.message}\n`);
    const usage = error instanceof UsageError || String(error.code).startsWith('ERR_PARSE_ARGS');
    return usage ? 2 : 1;
  }
}
