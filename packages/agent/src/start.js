import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { normalizeRtcIceOptions, parseRtcIceServersJson } from './sdk/rtcConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(rootDir, '.env') });

const staticHost = process.env.AGENT_STATIC_HOST || '0.0.0.0';
const staticPort = Number(process.env.AGENT_STATIC_PORT || 5175);
const signalingServer = process.env.SIGNALING_SERVER || 'http://localhost:8095';
const clientId = process.env.CLIENT_ID || 'client-1';
const daemonId = process.env.DAEMON_ID || 'daemon-1';

const parsedRtcIceServers = parseRtcIceServersJson(process.env.RTC_ICE_SERVERS_JSON);
if (String(process.env.RTC_ICE_SERVERS_JSON || '').trim() && !parsedRtcIceServers.length) {
  console.warn('Ignoring invalid RTC_ICE_SERVERS_JSON in agent .env.');
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

const publicHost = staticHost === '0.0.0.0' ? os.hostname() : staticHost;

const runtimeConfigPath = path.resolve(rootDir, 'agent-demo.runtime.json');
fs.writeFileSync(
  runtimeConfigPath,
  JSON.stringify(
    {
      signalingServer,
      clientId,
      daemonId,
      stunUrls: runtimeIceConfig.stunUrls,
      turnUrls: runtimeIceConfig.turnUrls,
      turnUsername: runtimeIceConfig.turnUsername,
      turnCredential: runtimeIceConfig.turnCredential,
      rtcIceServers: runtimeIceConfig.rtcIceServers,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function resolveSafePath(reqPath) {
  const rawPath = decodeURIComponent(reqPath.split('?')[0]);
  const normalized = rawPath === '/' ? '/agent.html' : rawPath;
  const relative = normalized.replace(/^\/+/, '');
  const baseDir = relative === 'agent.html' ? path.resolve(rootDir, 'public') : rootDir;
  const candidate = path.resolve(baseDir, relative);
  if (!candidate.startsWith(path.resolve(baseDir))) {
    return null;
  }
  return candidate;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const filePath = resolveSafePath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
    stream.pipe(res);
  });
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(
      `Agent static server failed to start: port ${staticPort} is already in use on ${staticHost}.`
    );
    console.error('Stop the existing process or set AGENT_STATIC_PORT to a free port.');
    process.exit(1);
    return;
  }

  console.error('Agent static server failed to start.', error);
  process.exit(1);
});

server.listen(staticPort, staticHost, () => {
  console.log(`Agent runtime config generated: ${runtimeConfigPath}`);
  console.log(`Agent static server running: http://${staticHost}:${staticPort}`);
  console.log(`Open agent page: http://${publicHost}:${staticPort}/agent.html`);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
