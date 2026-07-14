import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

const clientMessageTimeoutSeconds = readPositiveInt(process.env.DAEMON_CLIENT_MESSAGE_TIMEOUT_SECONDS, 120);

export const config = {
  signalingServer: process.env.SIGNALING_SERVER || 'http://localhost:8095',
  daemonId: process.env.DAEMON_ID || 'daemon-1',
  defaultClientId: process.env.CLIENT_ID || 'client-1',
  stunUrls: process.env.STUN_SERVER_URLS || '',
  turnUrls: process.env.TURN_SERVER_URLS || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
  staticServerHost: process.env.DAEMON_STATIC_HOST || '0.0.0.0',
  staticServerPort: Number(process.env.DAEMON_STATIC_PORT || 8788),
  browserHeadless: (process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true',
  targetPageWidthMax: readPositiveInt(process.env.TARGET_PAGE_WIDTH_MAX, 3840), // 4K default
  targetPageHeightMax: readPositiveInt(process.env.TARGET_PAGE_HEIGHT_MAX, 2160), // 4K default
  daemonLogLevel: process.env.DAEMON_LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  daemonLogFile: process.env.DAEMON_LOG_FILE || '/var/log/agent-browser-daemon.log',
  clientMessageTimeoutMs: clientMessageTimeoutSeconds * 1000,
  timeoutSnapshotDir: process.env.DAEMON_TIMEOUT_SNAPSHOT_DIR || path.resolve(__dirname, '../log/snapshots'),
};
