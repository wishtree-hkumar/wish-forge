import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAdapter } from './adapters/index.js';
import { appliesTo } from './adapters/shared.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import {
  planInstall,
  planRemove,
  planRulesWiring,
  planUnwire,
  planWire,
  rulesState,
  wiringState,
} from './plan.js';
import { findId, resolve } from './resolve.js';
import type { FileState } from './plan.js';
import type {
  Action,
  ActionType,
  Catalog,
  Context,
  Item,
  LockItem,
  Lock,
  RenderedFile,
  RuleListing,
  RulesRecord,
  Scope,
  WiringRecord,
} from './types.js';
import { RUNTIME_ID } from './wiring.js';

// One row of a report: an action, named by the item it is for.
export interface ReportRow {
  id: string;
  type: ActionType;
  path: string;
  reason?: string;
}

export interface TargetReport {
  target: string;
  root: string;
  actions: ReportRow[];
}

export interface Result {
  plans: TargetReport[];
  skipped: { target: string; id: string }[];
  kept?: { target: string; id: string; by: string }[];
}

export interface TargetStatus {
  target: string;
  root: string;
  wiring: { path: string; state: FileState } | null;
  rules: { path: string; state: FileState } | null;
  items: {
    id: string;
    explicit: boolean;
    files: { path: string; state: string }[];
  }[];
}

interface PlanEntry {
  id: string;
  actions: Action[];
  explicit?: boolean;
  files?: RenderedFile[];
  wiring?: WiringRecord;
}

interface Plan {
  target: string;
  root: string;
  items: PlanEntry[];
  before?: Action[];
  after?: Action[];
  rules?: RulesRecord | null;
}

const FILE_STATE: Partial<Record<ActionType, string>> = {
  delete: 'ok',
  keep: 'edited',
  missing: 'missing',
};

const baseOf = (ctx: Pick<Context, 'scope' | 'cwd' | 'home'>) =>
  ctx.scope === 'global' ? ctx.home : ctx.cwd;
const isHookItem = (item: Item) => item.type === 'hook' || item.type === 'runtime';
const isRuleId = (id: string) => id.startsWith('rule:');
// Hook wiring rows carry no id of their own; rules wiring rows do.
const wiringRow = ({ id = RUNTIME_ID, type, path, reason }: Action): ReportRow =>
  reason ? { id, type, path, reason } : { id, type, path };

// What a harness needs to list each rule, in name order. A rule that has left
// the catalog is still installed, so it stays listed without its patterns.
function describeRules(catalog: Catalog, ids: Iterable<string>): RuleListing[] {
  return [...ids].sort().map((id) => {
    const item = catalog.get(id);
    return { name: id.slice('rule:'.length), applies: item ? appliesTo(item) : undefined };
  });
}

// A plan is { target, root, items, before?, after?, rules? }. before and after hold
// wiring actions: unwire runs before files are removed, wire after they exist,
// so a harness config never points at a runner that is not there. rules is the
// lockfile's rules record after the operation: an object to set it, null to
// drop it, undefined to leave it.
function report(plans: Plan[]): TargetReport[] {
  return plans.map(({ target, root, items, before = [], after = [] }) => ({
    target,
    root,
    actions: [
      ...before.map(wiringRow),
      ...items.flatMap((entry) =>
        entry.actions.map(({ type, path, reason }) =>
          reason ? { id: entry.id, type, path, reason } : { id: entry.id, type, path }
        )
      ),
      ...after.map(wiringRow),
    ],
  }));
}

function commit(
  ctx: Context,
  lock: Lock,
  plans: Plan[],
  record: (items: Record<string, LockItem>, entry: PlanEntry) => void
): void {
  if (ctx.dryRun) return;
  for (const { root, items, before = [], after = [] } of plans) {
    const actions = [...before, ...items.flatMap((entry) => entry.actions), ...after];
    checkWritable(root, actions, ctx.force);
  }
  for (const plan of plans) {
    const target = (lock.targets[plan.target] ??= { items: {} });
    applyActions(plan.root, plan.before ?? [], ctx.force);
    for (const entry of plan.items) {
      applyActions(plan.root, entry.actions, ctx.force);
      record(target.items, entry);
    }
    applyActions(plan.root, plan.after ?? [], ctx.force);
    if (plan.rules === null) delete target.rules;
    else if (plan.rules) target.rules = plan.rules;
  }
  // Written last: a crash never leaves a lockfile that claims unwritten files.
  writeLock(baseOf(ctx), lock, ctx.version);
}

function install(
  ctx: Context,
  lock: Lock,
  perTarget: { target: string; entries: { item: Item; explicit: boolean }[] }[]
): TargetReport[] {
  const plans = perTarget.map(({ target, entries }): Plan => {
    if (ctx.scope === 'global' && entries.some(({ item }) => isHookItem(item))) {
      // When the hook only comes in as a requirement, name what asked for it.
      const hook = entries.find(({ item, explicit }) => item.type === 'hook' && !explicit);
      const by = hook && entries.find(({ item }) => item.requires.includes(hook.item.id));
      throw new UsageError(
        by
          ? `${by.item.id} requires ${hook.item.id}, which is installed per project only. ` +
              'Run this without --global.'
          : 'quality gates are installed per project. Run this without --global.'
      );
    }
    const adapter = getAdapter(target);
    const hasRule = entries.some(({ item }) => item.type === 'rule');
    if (ctx.scope === 'global' && hasRule && adapter.globalRules === false) {
      throw new UsageError(
        'Cursor keeps user-level rules in its settings, not in files. ' +
          'Install rules for cursor without --global.'
      );
    }
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    const after: Action[] = [];
    const items = entries.map(({ item, explicit }) => {
      const files = adapter.render(item, { scope: ctx.scope, version: ctx.version });
      const actions = planInstall(root, files, installed[item.id]?.files ?? []);
      const entry: PlanEntry = { id: item.id, explicit, files, actions };
      if (item.id === RUNTIME_ID && adapter.wiring) {
        const wired = planWire(root, adapter.wiring, installed[item.id]?.wiring);
        after.push(wired.action);
        entry.wiring = wired.record;
      }
      return entry;
    });
    let rules;
    const ids = [...new Set([...Object.keys(installed), ...entries.map(({ item }) => item.id)])];
    const rulesWiring = adapter.rulesWiring?.(ctx.scope, ids);
    const ruleIds = ids.filter(isRuleId);
    const record = lock.targets[target]?.rules;
    const wanted =
      rulesWiring?.kind === 'json' ? rulesWiring.entries.length > 0 : ruleIds.length > 0;
    if (rulesWiring && (wanted || record)) {
      const planned = planRulesWiring(
        root,
        rulesWiring,
        describeRules(ctx.catalog, ruleIds),
        record
      );
      after.push(planned.action);
      rules = planned.record;
    }
    return { target, root, items, after, rules };
  });

  const conflicts = plans.flatMap((plan) =>
    plan.items.flatMap((entry) =>
      entry.actions
        .filter((action) => action.type === 'conflict')
        .map(({ path, reason }) => ({ target: plan.target, path, reason }))
    )
  );
  if (conflicts.length > 0 && !ctx.force) throw new ConflictError(conflicts);

  commit(ctx, lock, plans, (items, entry) => {
    items[entry.id] = {
      explicit: entry.explicit!,
      files: entry.files!.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
      ...(entry.wiring ? { wiring: entry.wiring } : {}),
    };
  });
  return report(plans);
}

export function add(ctx: Context, refs: string[], targets: string[]): Result {
  const lock = readLock(baseOf(ctx));
  const resolved = resolve(ctx.catalog, refs);
  // The runtime is a requirement of the gates; installed alone it would never be swept.
  const hidden = resolved.find(({ item, explicit }) => explicit && item.type === 'runtime');
  if (hidden) {
    throw new UsageError(
      `${hidden.item.id} is installed with the quality gates that need it. Add a gate instead.`
    );
  }
  const perTarget = targets.map((target) => ({
    target,
    entries: resolved.map(({ item, explicit }) => ({
      item,
      explicit: explicit || lock.targets[target]?.items[item.id]?.explicit === true,
    })),
  }));
  return { plans: install(ctx, lock, perTarget), skipped: [] };
}

export function update(ctx: Context, refs: string[], targets: string[] | undefined): Result {
  const lock = readLock(baseOf(ctx));
  const skipped: Result['skipped'] = [];
  const named = refs.map((ref) => findId(ctx.catalog, ref));
  // Without --target, a named item is updated wherever it is installed.
  const everywhere = targets === undefined;
  if (everywhere) {
    for (const id of named) {
      if (!Object.values(lock.targets).some((target) => target.items[id])) {
        throw new UsageError(`${id} is not installed. Run "wishforge status" to see what is.`);
      }
    }
  }
  const perTarget = (targets ?? Object.keys(lock.targets)).flatMap((target) => {
    const installed = lock.targets[target]?.items ?? {};
    const wanted = everywhere ? named.filter((id) => installed[id]) : named;
    if (everywhere && named.length > 0 && wanted.length === 0) return [];
    const ids = named.length > 0 ? wanted : Object.keys(installed);
    const current: string[] = [];
    for (const id of ids) {
      if (!installed[id]) {
        throw new UsageError(
          `${id} is not installed for ${target}. Run "wishforge status" to see what is.`
        );
      }
      if (ctx.catalog.has(id)) current.push(id);
      else skipped.push({ target, id });
    }
    // Update refreshes what is installed. A requirement the catalog added since
    // is not installed by it: that is what add is for.
    const entries = resolve(ctx.catalog, current)
      .filter(({ item }) => installed[item.id])
      .map(({ item }) => ({ item, explicit: installed[item.id]?.explicit ?? false }));
    return [{ target, entries }];
  });
  return { plans: install(ctx, lock, perTarget), skipped };
}

// Gate state belongs to the runtime. When no target keeps the runtime, it goes,
// and so do .wishforge/local and .wishforge if nothing else is left in them.
function dropGateState(ctx: Context, lock: Lock): void {
  if (Object.values(lock.targets).some((target) => target.items[RUNTIME_ID])) return;
  const local = join(ctx.cwd, '.wishforge', 'local');
  rmSync(join(local, 'gate-state.json'), { force: true });
  try {
    const left = readdirSync(local);
    if (left.length === 1 && left[0] === '.gitignore') rmSync(local, { recursive: true });
    rmdirSync(join(ctx.cwd, '.wishforge'));
  } catch {
    // something else lives there
  }
}

// optional holds the items a bundle flag names: those installed are removed,
// the rest ignored. flags are the bundle flags, for the message when none is.
export function remove(
  ctx: Context,
  refs: string[],
  targets: string[],
  { optional = [], flags = [] }: { optional?: string[]; flags?: string[] } = {}
): Result {
  const lock = readLock(baseOf(ctx));
  // A full id is taken as given so items dropped from the catalog can still be removed.
  const named = refs.map((ref) => (ref.includes(':') ? ref : findId(ctx.catalog, ref)));
  const requiresOf = (id: string) => ctx.catalog.get(id)?.requires ?? [];
  const installedFor = (target: string) => lock.targets[target]?.items ?? {};
  if (
    named.length === 0 &&
    targets.every((target) => !optional.some((id) => installedFor(target)[id]))
  ) {
    throw new UsageError(
      `nothing named by ${flags.join(' ')} is installed for ${targets.join(', ')}.`
    );
  }

  const kept: NonNullable<Result['kept']> = [];
  const plans = targets.map((target): Plan => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = installedFor(target);
    for (const id of named) {
      if (!installed[id]) throw new UsageError(`${id} is not installed for ${target}.`);
    }
    // A bundle member that something staying installed requires is kept.
    const members = optional.filter((id) => installed[id] && !named.includes(id));
    const ids = [...new Set([...named, ...members])];
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...ids]) {
        if (!members.includes(id)) continue;
        const by = Object.keys(installed).find(
          (other) => !ids.includes(other) && requiresOf(other).includes(id)
        );
        if (by) {
          ids.splice(ids.indexOf(id), 1);
          kept.push({ target, id, by });
          changed = true;
        }
      }
    }

    const going = new Set(ids);
    for (const id of Object.keys(installed)) {
      if (going.has(id)) continue;
      const needed = requiresOf(id).find((dep) => going.has(dep));
      if (needed) {
        throw new UsageError(`cannot remove ${needed}: ${id} requires it. Remove ${id} first.`);
      }
    }

    // Sweep requirements nothing else needs, until none are left.
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, entry] of Object.entries(installed)) {
        if (going.has(id) || entry.explicit) continue;
        const stillNeeded = Object.keys(installed).some(
          (other) => !going.has(other) && requiresOf(other).includes(id)
        );
        if (!stillNeeded) {
          going.add(id);
          changed = true;
        }
      }
    }

    const before: Action[] = [];
    const wiring = installed[RUNTIME_ID]?.wiring;
    if (going.has(RUNTIME_ID) && wiring) {
      before.push(planUnwire(root, wiring, adapter.wiring));
    }
    const items = Object.keys(installed)
      .filter((id) => going.has(id))
      .map((id) => ({ id, actions: planRemove(root, installed[id].files) }));
    let rules;
    const record = lock.targets[target]?.rules;
    const staying = Object.keys(installed).filter((id) => !going.has(id));
    const rulesWiring = adapter.rulesWiring?.(ctx.scope, staying);
    // The user's file is looked at only when this removal changes what it
    // should hold. Removing anything else must not depend on that file.
    const wantedBefore = adapter.rulesWiring?.(ctx.scope, Object.keys(installed));
    const changes =
      [...going].some(isRuleId) ||
      JSON.stringify(wantedBefore?.entries) !== JSON.stringify(rulesWiring?.entries);
    if (record && changes) {
      rules = null;
      if (rulesWiring) {
        const planned = planRulesWiring(
          root,
          rulesWiring,
          describeRules(ctx.catalog, staying.filter(isRuleId)),
          record,
          { removing: true }
        );
        before.push(planned.action);
        rules = planned.record;
      }
    }
    return { target, root, items, before, rules };
  });

  commit(ctx, lock, plans, (items, entry) => {
    delete items[entry.id];
  });
  if (!ctx.dryRun && ctx.scope === 'project') dropGateState(ctx, lock);
  return { plans: report(plans), skipped: [], kept };
}

export function status(ctx: { scope: Scope; cwd: string; home: string }): TargetStatus[] {
  const lock = readLock(baseOf(ctx));
  return Object.entries(lock.targets).map(([target, installed]): TargetStatus => {
    const { items } = installed;
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const record = items[RUNTIME_ID]?.wiring;
    return {
      target,
      root,
      wiring:
        record && adapter.wiring
          ? { path: record.path, state: wiringState(root, adapter.wiring) }
          : null,
      rules:
        installed.rules && adapter.rulesWiring
          ? {
              path: installed.rules.path,
              state: rulesState(root, adapter.rulesWiring(ctx.scope, Object.keys(items))),
            }
          : null,
      items: Object.entries(items).map(([id, entry]) => ({
        id,
        explicit: entry.explicit,
        files: planRemove(root, entry.files).map(({ type, path }) => ({
          path,
          state: FILE_STATE[type]!,
        })),
      })),
    };
  });
}
