// Pure helpers for building/merging Chrome command-line args and reading the
// remote-debugging port. No instance state.

export function normalizeRemoteDebuggingPort(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

export function getArgName(arg = '') {
  const value = String(arg || '').trim();
  if (!value.startsWith('--')) {
    return value;
  }
  const eqIndex = value.indexOf('=');
  return eqIndex === -1 ? value : value.slice(0, eqIndex);
}

export function getArgValue(arg = '') {
  const value = String(arg || '').trim();
  if (!value.startsWith('--')) {
    return '';
  }
  const eqIndex = value.indexOf('=');
  return eqIndex === -1 ? '' : value.slice(eqIndex + 1);
}

export function resolveRemoteDebuggingPortFromArgs(args = []) {
  if (!Array.isArray(args)) {
    return null;
  }

  const entry = args.find((arg) => getArgName(arg) === '--remote-debugging-port');
  if (!entry) {
    return null;
  }

  return normalizeRemoteDebuggingPort(getArgValue(entry));
}

// Merge default args with custom args, keyed by arg name so a custom arg overrides
// the default with the same name.
export function mergeChromeArgs(defaultArgs = [], customArgs = []) {
  const merged = new Map();

  for (const arg of defaultArgs) {
    const argName = getArgName(arg);
    if (!argName) {
      continue;
    }
    merged.set(argName, arg);
  }

  for (const arg of customArgs) {
    const argName = getArgName(arg);
    if (!argName) {
      continue;
    }
    merged.set(argName, arg);
  }

  return Array.from(merged.values());
}

// Format a list of { name, value } param objects into `--name=value` / `--name` strings.
export function formatChromeArgs(params = []) {
  if (!Array.isArray(params)) {
    return [];
  }

  const args = [];
  for (const item of params) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const name = String(item.name || '').trim();
    if (!name.startsWith('--')) {
      continue;
    }

    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
    const value = hasValue ? String(item.value ?? '') : '';
    args.push(hasValue && value !== '' ? `${name}=${value}` : name);
  }

  return args;
}
