import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from './rtcConfig.js';

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

function readBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

const daemonTimeoutSeconds = readPositiveInt(process.env.DAEMON_TIMEOUT_SECONDS, 120);

// ICE config is single-sourced from RTC_ICE_SERVERS_JSON (the same variable the
// client uses), with the individual STUN_SERVER_URLS/TURN_* vars kept
// only as a fallback. normalizeRtcIceOptions derives stun/turn url lists and
// credentials from whichever form is supplied, so downstream (server.js ->
// daemon.html query params) keeps working unchanged.
const parsedRtcIceServers = parseRtcIceServersJson(process.env.RTC_ICE_SERVERS_JSON);
if (String(process.env.RTC_ICE_SERVERS_JSON || '').trim() && !parsedRtcIceServers.length) {
  console.warn('Ignoring invalid RTC_ICE_SERVERS_JSON in daemon .env.');
}

const hasExplicitIceEnv = [
  process.env.STUN_SERVER_URLS,
  process.env.TURN_SERVER_URLS,
  process.env.TURN_USERNAME,
  process.env.TURN_CREDENTIAL,
].some((value) => String(value || '').trim());

const runtimeIceConfig = normalizeRtcIceOptions(
  hasExplicitIceEnv
    ? {
        stunUrls: process.env.STUN_SERVER_URLS,
        turnUrls: process.env.TURN_SERVER_URLS,
        turnUsername: process.env.TURN_USERNAME,
        turnCredential: process.env.TURN_CREDENTIAL,
      }
    : {
        rtcIceServers: parsedRtcIceServers,
      }
);

export const config = {
  signalingServer: process.env.SIGNALING_SERVER || 'http://localhost:8095',
  daemonId: process.env.DAEMON_ID || 'daemon-1',
  clientId: process.env.CLIENT_ID || 'client-1',
  stunUrls: runtimeIceConfig.stunUrls,
  turnUrls: runtimeIceConfig.turnUrls,
  turnUsername: runtimeIceConfig.turnUsername,
  turnCredential: runtimeIceConfig.turnCredential,
  rtcIceServers: runtimeIceConfig.rtcIceServers,
  staticServerHost: process.env.DAEMON_STATIC_HOST || '0.0.0.0',
  staticServerPort: Number(process.env.DAEMON_STATIC_PORT || 8788),
  browserHeadless: (process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true',
  enableHeadlessCalibration: readBoolean(process.env.DAEMON_ENABLE_HEADLESS_CALIBRATION, true),
  targetPageWidthMax: readPositiveInt(process.env.TARGET_PAGE_WIDTH_MAX, 3840), // 4K default
  targetPageHeightMax: readPositiveInt(process.env.TARGET_PAGE_HEIGHT_MAX, 2160), // 4K default
  daemonLogLevel: process.env.DAEMON_LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  daemonLogFile: process.env.DAEMON_LOG_FILE || '/var/log/agent-browser-daemon.log',
  daemonTimeoutMs: daemonTimeoutSeconds * 1000,
  // Grace window after a `leave` before the session is actually terminated. A
  // page refresh and a page close both emit `leave`; if the same client
  // reconnects within this window we treat it as a refresh and cancel the
  // termination. Only a genuine close lets the timer elapse.
  leaveGraceMs: readPositiveInt(process.env.DAEMON_LEAVE_GRACE_MS, 8000),
  timeoutSnapshotDir: process.env.DAEMON_TIMEOUT_SNAPSHOT_DIR || path.resolve(__dirname, '../log/snapshots'),
};
