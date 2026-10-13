import { getAdapter } from './adapters/index.js';
import { applyActions, checkWritable } from './apply.js';
import { ConflictError, UsageError } from './errors.js';
import { readLock, sha256, writeLock } from './lock.js';
import { planInstall, planRemove } from './plan.js';
import { findId, resolve } from './resolve.js';

const FILE_STATE = { delete: 'ok', keep: 'edited', missing: 'missing' };

const baseOf = (ctx) => (ctx.scope === 'global' ? ctx.home : ctx.cwd);

function report(plans) {
  return plans.map(({ target, root, items }) => ({
    target,
    root,
    actions: items.flatMap((entry) =>
      entry.actions.map(({ type, path, reason }) =>
        reason ? { id: entry.id, type, path, reason } : { id: entry.id, type, path }
      )
    ),
  }));
}

function commit(ctx, lock, plans, record) {
  if (ctx.dryRun) return;
  for (const plan of plans) {
    checkWritable(plan.root, plan.items.flatMap((entry) => entry.actions), ctx.force);
  }
  for (const plan of plans) {
    const target = (lock.targets[plan.target] ??= { items: {} });
    for (const entry of plan.items) {
      applyActions(plan.root, entry.actions, ctx.force);
      record(target.items, entry);
    }
  }
  // Written last: a crash never leaves a lockfile that claims unwritten files.
  writeLock(baseOf(ctx), lock, ctx.version);
}

// perTarget: [{ target, entries: [{ item, explicit }] }]
function install(ctx, lock, perTarget) {
  const plans = perTarget.map(({ target, entries }) => {
    const adapter = getAdapter(target);
    const root = adapter.root(ctx.scope, ctx);
    const installed = lock.targets[target]?.items ?? {};
    const items = entries.map(({ item, explicit }) => {
      const files = adapter.render(item, { scope: ctx.scope, version: ctx.version });
      const actions = planInstall(root, files, installed[item.id]?.files ?? []);
      return { id: item.id, explicit, files, actions };
    });
    return { target, root, items };
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
  const perTarget = (targets ?? Object.keys(lock.targets)).map((target) => {
    const installed = lock.targets[target]?.items ?? {};
    const ids =
      refs.length > 0 ? refs.map((ref) => findId(ctx.catalog, ref)) : Object.keys(installed);
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
    return { target, entries };
  });
  return { plans: install(ctx, lock, perTarget), skipped };
}

export function remove(ctx, refs, targets) {
  const lock = readLock(baseOf(ctx));
  // A full id is taken as given so items dropped from the catalog can still be removed.
  const ids = refs.map((ref) => (ref.includes(':') ? ref : findId(ctx.catalog, ref)));
  const requiresOf = (id) => ctx.catalog.get(id)?.requires ?? [];

  const plans = targets.map((target) => {
    const root = getAdapter(target).root(ctx.scope, ctx);
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
    for (let changed = true; changed; ) {
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

    const items = Object.keys(installed)
      .filter((id) => going.has(id))
      .map((id) => ({ id, actions: planRemove(root, installed[id].files) }));
    return { target, root, items };
  });

  commit(ctx, lock, plans, (items, entry) => {
    delete items[entry.id];
  });
  return { plans: report(plans), skipped: [] };
}

export function status(ctx) {
  const lock = readLock(baseOf(ctx));
  return Object.entries(lock.targets).map(([target, { items }]) => {
    const root = getAdapter(target).root(ctx.scope, ctx);
    return {
      target,
      root,
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
