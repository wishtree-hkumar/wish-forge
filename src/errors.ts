export class CatalogError extends Error {}
export class UsageError extends Error {}
export class LockError extends Error {}
export class ConfigError extends Error {}

export interface Conflict {
  target: string;
  path: string;
  reason: string | undefined;
}

export class ConflictError extends Error {
  conflicts: Conflict[];

  constructor(conflicts: Conflict[]) {
    super(`${conflicts.length} file(s) would be overwritten`);
    this.conflicts = conflicts;
  }
}
