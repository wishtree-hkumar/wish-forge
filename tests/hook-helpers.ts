export function runtimeTree() {
  return {
    'runtime/hooks/RUNTIME.md': '---\nname: hooks\ndescription: Hook runner.\n---\nRuns gates.\n',
    'runtime/hooks/run.mjs': '// run\n',
    'runtime/hooks/runtime.mjs': '// runtime\n',
    'runtime/hooks/opencode-plugin.js': '// plugin\n',
  };
}

export function hookTree(name, events = '[shell]') {
  return {
    [`hooks/${name}/HOOK.md`]: `---\nname: ${name}\ndescription: Gate ${name}.\nevents: ${events}\n---\nAbout ${name}.\n`,
    [`hooks/${name}/gate.mjs`]: `export function check() {}\n// ${name}\n`,
  };
}
