import fs from 'node:fs';
import path from 'node:path';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : 'info';
}

const configuredLevel = normalizeLevel(process.env.DAEMON_LOG_LEVEL || process.env.LOG_LEVEL || 'info');
const configuredLogFile = String(process.env.DAEMON_LOG_FILE || '/var/log/agent-browser-daemon.log').trim();

let fileStream = null;
let fileLoggingDisabled = false;

function getFileStream() {
  if (fileLoggingDisabled) {
    return null;
  }

  if (fileStream) {
    return fileStream;
  }

  try {
    const logDir = path.dirname(configuredLogFile);
    fs.mkdirSync(logDir, { recursive: true });
    fileStream = fs.createWriteStream(configuredLogFile, { flags: 'a' });
    fileStream.on('error', (error) => {
      fileLoggingDisabled = true;
      fileStream = null;
      console.warn(`[daemon-logger] file logging disabled: ${error.message}`);
    });
    return fileStream;
  } catch (error) {
    fileLoggingDisabled = true;
    console.warn(`[daemon-logger] failed to open log file ${configuredLogFile}: ${error.message}`);
    return null;
  }
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[configuredLevel];
}

function emit(level, scope, args) {
  if (!shouldLog(level)) {
    return;
  }

  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}]`;
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(prefix, ...args);

  const stream = getFileStream();
  if (stream) {
    const normalizedArgs = args.map((value) => {
      if (typeof value === 'string') {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    });
    stream.write(`${prefix} ${normalizedArgs.join(' ')}\n`);
  }
}

export function createLogger(scope = 'daemon') {
  return {
    level: configuredLevel,
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
  };
}
