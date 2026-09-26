export function loadPlugin(pluginName: string): unknown {
  // Dynamic require with variable
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const plugin = require(pluginName);
  return plugin;
}

export function executeSnippet(code: string): unknown {
  // Eval dynamic execution
  return eval(code);
}
