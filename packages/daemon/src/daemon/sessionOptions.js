// Pure parsing/normalization helpers for daemon session inputs and tool-mode CLI
// options. No I/O and no module state -- every function is a pure function of its
// arguments, so the runtime (index.js) can stay focused on orchestration.

import { createPeerIds } from '../../../client/src/sdk/config/peerIds.js';

// Flattens a value (array/string) into a clean list of ICE (STUN/TURN) URLs,
// splitting on commas/newlines and dropping empties.
export function normalizeIceUrlList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeIceUrlList(entry))
      .filter(Boolean);
  }

  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Parses the `chromeParams` input (JSON array, JSON string, or empty) into an array.
export function parseChromeParamsValue(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }

  if (Array.isArray(raw)) {
    return raw;
  }

  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('chromeParams must be a JSON array.');
    }
    return parsed;
  }

  throw new Error('chromeParams must be a JSON array or JSON string array.');
}

// Parses a positive timeout (in seconds), falling back when unset.
export function parseTimeoutSeconds(value, fallbackSeconds) {
  if (value === undefined || value === null || value === '') {
    return fallbackSeconds;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('timeout must be a positive number (seconds).');
  }

  return Math.floor(parsed);
}

export function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Canonical form for comparing peer/client identifiers (case- and whitespace-insensitive).
export function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

// Converts a `--kebab-case` CLI flag name into its camelCase option key.
export function normalizeToolFlagName(name) {
  const raw = String(name || '').trim();
  if (!raw) {
    return '';
  }
  const base = raw.replace(/^-+/, '');
  return base.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

// Parses `--flag value` / `--flag=value` argv into a tool-mode session-start payload.
// Returns null when argv is not a tool-mode invocation or lacks the required fields.
export function parseDaemonToolOptions(argv = []) {
  if (!Array.isArray(argv) || !argv.length) {
    return null;
  }

  if (!argv.some((arg) => String(arg || '').startsWith('--'))) {
    return null;
  }

  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token.startsWith('--')) {
      continue;
    }

    const eqIndex = token.indexOf('=');
    const rawName = eqIndex === -1 ? token : token.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? '' : token.slice(eqIndex + 1);
    const key = normalizeToolFlagName(rawName);
    if (!key) {
      continue;
    }

    if (eqIndex !== -1) {
      options[key] = inlineValue;
      continue;
    }

    const next = index + 1 < argv.length ? String(argv[index + 1] || '') : '';
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  const payload = {
    targetUrl: options.targetUrl,
    sessionId: options.sessionId,
  };

  payload.sessionId = String(payload.sessionId || '').trim();

  if (payload.sessionId) {
    const derived = createPeerIds(payload.sessionId);
    payload.daemonId = payload.daemonId || derived.daemonId;
    payload.clientId = payload.clientId || derived.clientId;
  }

  if (!payload.daemonId || !payload.clientId || !payload.targetUrl) {
    return null;
  }

  if (options.timeout !== undefined) {
    payload.timeout = Number(options.timeout);
  }
  if (options.signalingServer !== undefined) {
    payload.signalingServer = String(options.signalingServer || '').trim();
  }
  if (options.stunUrls !== undefined) {
    payload.stunUrls = options.stunUrls;
  }
  if (options.turnUrls !== undefined) {
    payload.turnUrls = options.turnUrls;
  }
  if (options.turnUsername !== undefined) {
    payload.turnUsername = options.turnUsername;
  }
  if (options.turnCredential !== undefined) {
    payload.turnCredential = options.turnCredential;
  }
  if (options.chrome !== undefined) {
    payload.chrome = options.chrome;
  }
  if (options.remoteDebuggingPort !== undefined) {
    payload.remoteDebuggingPort = options.remoteDebuggingPort;
  }
  if (options.chromeParams !== undefined) {
    payload.chromeParams = options.chromeParams;
  }
  if (options.jsonCompact !== undefined) {
    payload.jsonCompact = Boolean(options.jsonCompact);
  }

  return payload;
}

// Emits a tool-mode result as JSON to stdout (or stderr on error).
export function emitToolResult(data, { compact = false, isError = false } = {}) {
  const text = compact
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);
  if (isError) {
    console.error(text);
    return;
  }
  console.log(text);
}
