import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getAdapter, targetNames } from './adapters/index.js';
import { STAGES, loadCatalog } from './catalog.js';
import { runDoctor } from './doctor.js';
import { ConflictError, UsageError } from './errors.js';
import { add, remove, status, update } from './ops.js';
import { findId } from './resolve.js';
import { estimateTokens, tokensOf } from './tokens.js';

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
  forgeflow tokens [--target <t>[,<t>...]] [--global] [--json]
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
  rewire: 'updated',
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

function printResult(stdout, { plans, skipped, kept = [] }, dryRun) {
  for (const { target, root, actions } of plans) {
    // A target a bundle flag found nothing for has nothing to show.
    if (actions.length === 0) continue;
    stdout.write(`${target}  (${root})\n`);
    for (const { type, path, reason } of actions) {
      const label = (LABELS[type] ?? type).padEnd(12);
      stdout.write(`  ${label} ${path}${reason ? `  (${reason})` : ''}\n`);
    }
  }
  for (const { target, id, by } of kept) {
    stdout.write(`[${target}] ${id} is kept: ${by} requires it.\n`);
  }
  for (const { target, id } of skipped) {
    stdout.write(`[${target}] ${id} is no longer in the catalog; left as installed.\n`);
  }
  if (dryRun) stdout.write('Dry run: nothing was written.\n');
}

// The first sentence of a description, before any " - " list: enough to tell
// items apart in a list.
const summary = (text) => text.split(/(?<=\.)\s/)[0].split(' - ')[0];
const byName = (a, b) => a.name.localeCompare(b.name);
const stageOrder = (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || byName(a, b);

function applies(item) {
  if (!item.paths) return 'all work';
  const text = item.paths.map((pattern) => pattern.replace(/^\*\*\//, '')).join(' ');
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

// Headings in the order they print, each with what belongs under it, its sort
// order and the columns of one row.
const LIST_GROUPS = [
  {
    title: 'Flow agents',
    has: (item) => item.type === 'agent' && item.stage !== undefined,
    order: stageOrder,
    row: (item) => [item.stage.toUpperCase(), item.access],
  },
  {
    title: 'Specialists',
    has: (item) => item.type === 'agent' && item.stage === undefined,
    row: (item) => [item.joins ? 'reviewer' : '', item.access],
  },
  { title: 'Flows', has: (item) => item.type === 'skill' && !item.group, row: () => [] },
  { title: 'Quality gates', has: (item) => item.type === 'hook' && !item.group, row: () => [] },
  {
    title: 'Session memory',
    has: (item) => item.group === 'memory',
    row: (item) => [item.type === 'hook' ? 'hook' : 'command'],
  },
  { title: 'Rules packs', has: (item) => item.type === 'rule', row: (item) => [applies(item)] },
];

// In a terminal each line is cut to its width; piped output is left whole.
function fitter(stdout) {
  const width = stdout.isTTY && stdout.columns > 0 ? stdout.columns : Infinity;
  return (line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line);
}

const number = (value) => value.toLocaleString('en-US');

function printTokens(stdout, targets) {
  if (targets.length === 0) {
    stdout.write(NOTHING);
    return;
  }
  const fit = fitter(stdout);
  const labels = targets
    .flatMap(({ always, onUse }) => [...always, ...onUse])
    .map((row) => row.label);
  const labelWidth = Math.max(28, ...labels.map((label) => label.length));
  const line = (label, value) => fit(`    ${label.padEnd(labelWidth)}  ${value.padStart(8)}`);
  for (const { target, root, always, onUse } of targets) {
    stdout.write(`${target}  (${root})\n`);
    stdout.write(
      `${fit(`  ${'Every session'.padEnd(labelWidth + 2)}  ${'~ tokens'.padStart(8)}`)}\n`
    );
    for (const { label, chars } of always)
      stdout.write(`${line(label, number(tokensOf(chars)))}\n`);
    const total = always.reduce((all, { chars }) => all + tokensOf(chars), 0);
    stdout.write(`${line('total', `~${number(total)}`)}\n`);
    if (onUse.length > 0) {
      stdout.write('  When used\n');
      for (const { label, chars } of onUse)
        stdout.write(`${line(label, number(tokensOf(chars)))}\n`);
    }
    stdout.write('\n');
  }
  stdout.write(
    `${fit("Estimates at about 4 characters per token. The harness's own prompts and tools, and your own instruction files, are not included.")}\n`
  );
}

function printList(stdout, items) {
  const fit = fitter(stdout);
  const blocks = [];
  for (const group of LIST_GROUPS) {
    const members = items.filter(group.has).sort(group.order ?? byName);
    if (members.length === 0) continue;
    const rows = members.map((item) => [item.name, ...group.row(item), summary(item.description)]);
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
    const lines = rows.map((row) =>
      fit(
        `  ${row
          .map((cell, column) => (column < row.length - 1 ? cell.padEnd(widths[column]) : cell))
          .join('  ')}`.replace(/\s+$/, '')
      )
    );
    blocks.push([group.title, ...lines].join('\n'));
  }
  if (blocks.length === 0) {
    stdout.write('Nothing to list.\n');
    return;
  }
  const count = `${items.length} item${items.length === 1 ? '' : 's'}`;
  stdout.write(
    `${blocks.join('\n\n')}\n\n${fit(`${count}. Run "forgeflow info <name>" for the full description.`)}\n`
  );
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

function samePlace(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// The items the bundle flags name, and the flags that were given.
function bundles(values, catalog) {
  const ids = [];
  const flags = [];
  const pick = (flag, test) => {
    flags.push(flag);
    const items = [...catalog.values()].filter(test);
    ids.push(...items.map((item) => item.id).sort());
  };
  if (values.flow !== undefined) {
    if (!['quick', 'full'].includes(values.flow)) {
      throw new UsageError('--flow must be quick or full.');
    }
    pick(`--flow ${values.flow}`, (item) => item.id === `skill:forge-${values.flow}`);
  }
  // A hook in a group belongs to that group's bundle, not to the gates.
  if (values.hooks) pick('--hooks', (item) => item.type === 'hook' && item.group === undefined);
  if (values.specialists) {
    pick('--specialists', (item) => item.type === 'agent' && item.stage === undefined);
  }
  if (values.memory) pick('--memory', (item) => item.group === 'memory');
  return { ids, flags };
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

  // Global installs live in the home folder, so it cannot also be a project.
  const changes = ['add', 'remove', 'update'].includes(command);
  if (changes && ctx.scope === 'project' && samePlace(cwd, home)) {
    throw new UsageError(
      'this is your home folder, where --global installs live. ' +
        'Run forgeflow from a project folder, or add --global.'
    );
  }

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
        printList(stdout, items);
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
      const { ids } = bundles(values, catalog);
      const wanted = [...refs, ...ids];
      if (wanted.length === 0) {
        throw new UsageError(
          'name at least one item, or use --flow quick|full, --hooks, --specialists or --memory.'
        );
      }
      printResult(stdout, add(ctx, wanted, parseTargets(values.target, true)), ctx.dryRun);
      return 0;
    }

    case 'remove': {
      const { ids, flags } = bundles(values, catalog);
      if (refs.length === 0 && ids.length === 0) {
        throw new UsageError('name at least one item to remove.');
      }
      const targets = parseTargets(values.target, true);
      const result = remove(ctx, refs, targets, { optional: ids, flags });
      printResult(stdout, result, ctx.dryRun);
      return 0;
    }

    case 'update': {
      if (bundles(values, catalog).flags.length > 0) {
        throw new UsageError(
          'update takes item names. Without names it updates everything installed.'
        );
      }
      const result = update(ctx, refs, parseTargets(values.target, false));
      if (result.plans.length === 0) stdout.write(NOTHING);
      else printResult(stdout, result, ctx.dryRun);
      return 0;
    }

    case 'tokens': {
      const targets = estimateTokens(ctx, parseTargets(values.target, false));
      if (values.json) {
        const rows = targets.flatMap(({ target, always, onUse }) =>
          [
            ...always.map((row) => ({ ...row, section: 'every session' })),
            ...onUse.map((row) => ({ ...row, section: 'when used' })),
          ].map(({ label, chars, section }) => ({
            target,
            section,
            label,
            chars,
            tokens: tokensOf(chars),
          }))
        );
        stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        printTokens(stdout, targets);
      }
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
