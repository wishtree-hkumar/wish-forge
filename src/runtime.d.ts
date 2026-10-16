// The build compiles src/ alone, so it cannot read the types of the hook
// runtime, which stays JavaScript in catalog/. This declares the part tokens.ts
// uses. tsconfig.json checks the runtime itself, and resolves this import to
// it, so a change there that breaks tokens.ts still fails the type check.
declare module '*/runtime/hooks/runtime.mjs' {
  export function findRun(root: string, now?: number): { name: string } | null;
}
