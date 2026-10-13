export class CatalogError extends Error {}
export class UsageError extends Error {}
export class LockError extends Error {}
export class ConfigError extends Error {}

export class ConflictError extends Error {
  // conflicts: [{ target, path, reason }]
  constructor(conflicts) {
    super(`${conflicts.length} file(s) would be overwritten`);
    this.conflicts = conflicts;
  }
}
