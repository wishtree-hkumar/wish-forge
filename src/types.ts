// The shapes the CLI passes between its modules.

export type ItemType = 'agent' | 'skill' | 'hook' | 'rule' | 'runtime';
export type Scope = 'project' | 'global';

// A supporting file of a skill, copied as it is.
export interface ItemFile {
  path: string;
  content: Buffer;
}

// One catalog item. Which of the optional fields are set depends on its type.
export interface Item {
  id: string;
  type: ItemType;
  name: string;
  description: string;
  requires: string[];
  body: string;
  files: ItemFile[];
  source: string;
  // agent
  stage?: string;
  access?: string;
  modelTier?: string;
  joins?: string;
  // skill
  userInvocableOnly?: boolean;
  // skill or hook
  group?: string;
  // hook
  events?: string[];
  gate?: string;
  // rule; absent means the rule applies to all work
  paths?: string[];
  // runtime: its source files by name
  sources?: Record<string, string>;
}

export type Catalog = Map<string, Item>;

// A file an adapter writes for an item.
export interface RenderedFile {
  path: string;
  content: string | Buffer;
}

export type ActionType =
  | 'create'
  | 'skip'
  | 'conflict'
  | 'update'
  | 'delete'
  | 'keep'
  | 'missing'
  | 'wire'
  | 'unwire'
  | 'rewire'
  | 'manual';

// One step of a plan. Actions with content write it; the rest delete or do nothing.
export interface Action {
  id?: string;
  type: ActionType;
  path: string;
  content?: string | Buffer;
  reason?: string;
}

export interface LockFileEntry {
  path: string;
  sha256: string;
}

export interface WiringRecord {
  path: string;
  created: boolean;
}

export interface RulesRecord {
  path: string;
  created: boolean;
  manual?: boolean;
}

export interface LockItem {
  explicit: boolean;
  files: LockFileEntry[];
  wiring?: WiringRecord;
}

export interface LockTarget {
  items: Record<string, LockItem>;
  rules?: RulesRecord;
}

export interface Lock {
  version: number;
  wishforge: string | null;
  targets: Record<string, LockTarget>;
}

// A harness config file as JSON: only the keys wishforge edits are typed.
export interface HarnessConfig {
  hooks?: Record<string, unknown[]>;
  instructions?: string[];
  [key: string]: unknown;
}

// A command a harness runs for a hook event.
export interface HookHandler {
  type?: string;
  command: string;
  timeout?: number;
}

// What wishforge adds to one event's list: a group of handlers for Claude
// Code and Codex, a handler of its own for Cursor.
export interface HookEntry {
  matcher?: string;
  hooks?: HookHandler[];
  command?: string;
  timeout?: number;
}

// Where a harness reads hooks from, and the entries wishforge adds there.
export interface HookWiring {
  path: string;
  runner: string;
  skeleton: HarnessConfig;
  entries: Record<string, HookEntry>;
}

// A rule as a harness lists it. applies is unknown for a rule that has left the catalog.
export interface RuleListing {
  name: string;
  applies: string | undefined;
}

// Rules listed in a block of a markdown file, such as AGENTS.md.
export interface BlockRulesWiring {
  kind: 'block';
  path: string;
  block: (rules: RuleListing[]) => string;
  entries?: never;
}

// Rules and memory loaded through a JSON config's "instructions" list.
export interface JsonRulesWiring {
  kind: 'json';
  path: string;
  alternative: string;
  entries: string[];
  known: string[];
  skeleton: HarnessConfig;
}

export type RulesWiring = BlockRulesWiring | JsonRulesWiring;

export interface Places {
  agentDirs: { project: string; global: string };
  rulesLocation: string;
}

export interface Dirs {
  cwd: string;
  home: string;
}

// What each module in src/adapters exports.
export interface Adapter extends Places {
  name: string;
  places: Places;
  wiring: HookWiring | null;
  globalRules?: boolean;
  root(scope: Scope, dirs: Dirs): string;
  render(item: Item, ctx: { scope: Scope; version: string }): RenderedFile[];
  rulesWiring?(scope: Scope, ids?: string[]): RulesWiring;
}

// What a command runs with.
export interface Context extends Dirs {
  catalog: Catalog;
  version: string;
  scope: Scope;
  force: boolean;
  dryRun: boolean;
  // Milliseconds since the epoch; tests fix it.
  now?: number;
}

// Somewhere output is written, such as process.stdout.
export interface Output {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
