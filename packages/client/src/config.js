import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from './sdk/config/rtcConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

// The client fetches this at `/client.runtime.json`. `pnpm start` writes it here
// and serves it from the package root; the Vite dev/preview server generates it
// on the fly via buildClientRuntimeConfig(). Both derive from the same source:
// this module + the package `.env`.
export const RUNTIME_CONFIG_PATH = path.resolve(packageRoot, 'client.runtime.json');

let envLoaded = false;
function ensureEnvLoaded() {
  if (!envLoaded) {
    dotenv.config({ path: path.resolve(packageRoot, '.env') });
    envLoaded = true;
  }
}

// Build the client runtime config object from environment variables. This is the
// single source of truth shared by the static server (src/start.js) and the Vite
// dev/preview server (vite.config.js).
export function buildClientRuntimeConfig() {
  ensureEnvLoaded();

  const signalingServer = process.env.SIGNALING_SERVER || 'http://localhost:8095';
  const clientId = process.env.CLIENT_ID || 'client-1';
  const daemonId = process.env.DAEMON_ID || 'daemon-1';
  const headless = String(process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true';

  const parsedRtcIceServers = parseRtcIceServersJson(process.env.RTC_ICE_SERVERS_JSON);
  if (String(process.env.RTC_ICE_SERVERS_JSON || '').trim() && !parsedRtcIceServers.length) {
    console.warn('Ignoring invalid RTC_ICE_SERVERS_JSON in client .env.');
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

  return {
    signalingServer,
    clientId,
    daemonId,
    headless,
    stunUrls: runtimeIceConfig.stunUrls,
    turnUrls: runtimeIceConfig.turnUrls,
    turnUsername: runtimeIceConfig.turnUsername,
    turnCredential: runtimeIceConfig.turnCredential,
    rtcIceServers: runtimeIceConfig.rtcIceServers,
  };
}

// Serialize the config exactly as it is served over HTTP.
export function serializeClientRuntimeConfig(config = buildClientRuntimeConfig()) {
  return JSON.stringify(config, null, 2) + '\n';
}

// Write the generated config to RUNTIME_CONFIG_PATH (used by the static server).
export function writeClientRuntimeConfig(config = buildClientRuntimeConfig()) {
  fs.writeFileSync(RUNTIME_CONFIG_PATH, serializeClientRuntimeConfig(config), 'utf8');
  return config;
}
