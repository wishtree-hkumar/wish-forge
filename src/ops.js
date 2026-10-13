import { getAdapter } from './adapters/index.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import { planInstall, planRemove, planUnwire, planWire, wiringState } from './plan.js';
import { findId, resolve } from './resolve.js';
import { RUNTIME_ID } from './wiring.js';

const FILE_STATE = { delete: 'ok', keep: 'edited', missing: 'missing' };

const baseOf = (ctx) => (ctx.scope === 'global' ? ctx.home : ctx.cwd);
const isHookItem = (item) => item.type === 'hook' || item.type === 'runtime';
const wiringRow = ({ type, path }) => ({ id: RUNTIME_ID, type, path });

// A plan is { target, root, items, before?, after? }. before and after hold
// wiring actions: unwire runs before files are removed, wire after they exist,
// so a harness config never points at a runner that is not there.
function report(plans) {
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

function commit(ctx, lock, plans, record) {
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
  }
  // Written last: a crash never leaves a lockfile that claims unwritten files.
  writeLock(baseOf(ctx), lock, ctx.version);
}

// perTarget: [{ target, entries: [{ item, explicit }] }]
function install(ctx, lock, perTarget) {
  const plans = perTarget.map(({ target, entries }) => {
    if (ctx.scope === 'global' && entries.some(({ item }) => isHookItem(item))) {
      throw new UsageError('quality gates are installed per project. Run this without --global.');
    }
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    const after = [];
    const items = entries.map(({ item, explicit }) => {
      const files = adapter.render(item, { scope: ctx.scope, version: ctx.version });
      const actions = planInstall(root, files, installed[item.id]?.files ?? []);
      const entry = { id: item.id, explicit, files, actions };
      if (item.id === RUNTIME_ID && adapter.wiring) {
        const wired = planWire(root, adapter.wiring, installed[item.id]?.wiring);
        after.push(wired.action);
        entry.wiring = wired.record;
      }
      return entry;
    });
    return { target, root, items, after };
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
      explicit: entry.explicit,
      files: entry.files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
      ...(entry.wiring ? { wiring: entry.wiring } : {}),
    };
  });
  return report(plans);
}

export function add(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  const resolved = resolve(ctx.catalog, refs);
  const perTarget = targets.map((target) => ({
    target,
    entries: resolved.map(({ item, explicit }) => ({
      item,
      explicit: explicit || lock.targets[target]?.items[item.id]?.explicit === true,
    })),
  }));
  return { plans: install(ctx, lock, perTarget), skipped: [] };
}

export function update(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  const skipped = [];
  const named = refs.map((ref) => findId(ctx.catalog, ref));
  // Without --target, a named item is updated wherever it is installed.
  const everywhere = targets === undefined;
  if (everywhere) {
    for (const id of named) {
      if (!Object.values(lock.targets).some((target) => target.items[id])) {
        throw new UsageError(`${id} is not installed. Run "forgeflow status" to see what is.`);
      }
    }
  }
  const perTarget = (targets ?? Object.keys(lock.targets)).flatMap((target) => {
    const installed = lock.targets[target]?.items ?? {};
    const wanted = everywhere ? named.filter((id) => installed[id]) : named;
    if (everywhere && named.length > 0 && wanted.length === 0) return [];
    const ids = named.length > 0 ? wanted : Object.keys(installed);
    const current = [];
    for (const id of ids) {
      if (!installed[id]) {
        throw new UsageError(
          `${id} is not installed for ${target}. Run "forgeflow status" to see what is.`
        );
      }
      if (ctx.catalog.has(id)) current.push(id);
      else skipped.push({ target, id });
    }
    const entries = resolve(ctx.catalog, current).map(({ item }) => ({
      item,
      explicit: installed[item.id]?.explicit ?? false,
    }));
    return [{ target, entries }];
  });
  return { plans: install(ctx, lock, perTarget), skipped };
}

export function remove(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  // A full id is taken as given so items dropped from the catalog can still be removed.
  const ids = refs.map((ref) => (ref.includes(':') ? ref : findId(ctx.catalog, ref)));
  const requiresOf = (id) => ctx.catalog.get(id)?.requires ?? [];

  const plans = targets.map((target) => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    for (const id of ids) {
      if (!installed[id]) throw new UsageError(`${id} is not installed for ${target}.`);
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

    const before = [];
    const wiring = installed[RUNTIME_ID]?.wiring;
    if (going.has(RUNTIME_ID) && wiring) {
      before.push(planUnwire(root, wiring, adapter.wiring));
    }
    const items = Object.keys(installed)
      .filter((id) => going.has(id))
      .map((id) => ({ id, actions: planRemove(root, installed[id].files) }));
    return { target, root, items, before };
  });

  commit(ctx, lock, plans, (items, entry) => {
    delete items[entry.id];
  });
  return { plans: report(plans), skipped: [] };
}

export function status(ctx) {
  const lock = readLock(baseOf(ctx));
  return Object.entries(lock.targets).map(([target, { items }]) => {
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
      items: Object.entries(items).map(([id, entry]) => ({
        id,
        explicit: entry.explicit,
        files: planRemove(root, entry.files).map(({ type, path }) => ({
          path,
          state: FILE_STATE[type],
        })),
      })),
    };
  });
}
