import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { writeClientRuntimeConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(rootDir, '.env') });

const staticHost = process.env.CLIENT_STATIC_HOST || '0.0.0.0';
const staticPort = Number(process.env.CLIENT_STATIC_PORT || 5174);
const publicHost = staticHost === '0.0.0.0' ? os.hostname() : staticHost;

// Enable HTTPS by setting CLIENT_STATIC_HTTPS=true and pointing
// CLIENT_STATIC_TLS_CERT / CLIENT_STATIC_TLS_KEY at PEM files. When disabled (the
// default) the server falls back to plain HTTP.
const useHttps = String(process.env.CLIENT_STATIC_HTTPS || 'false').toLowerCase() === 'true';

function loadTlsOptions() {
  const certPath = process.env.CLIENT_STATIC_TLS_CERT;
  const keyPath = process.env.CLIENT_STATIC_TLS_KEY;
  if (!certPath || !keyPath) {
    console.error(
      'CLIENT_STATIC_HTTPS is enabled but CLIENT_STATIC_TLS_CERT and/or CLIENT_STATIC_TLS_KEY are not set.'
    );
    process.exit(1);
  }
  try {
    const options = {
      cert: fs.readFileSync(path.resolve(rootDir, certPath)),
      key: fs.readFileSync(path.resolve(rootDir, keyPath)),
    };
    const caPath = process.env.CLIENT_STATIC_TLS_CA;
    if (caPath) {
      options.ca = fs.readFileSync(path.resolve(rootDir, caPath));
    }
    const passphrase = process.env.CLIENT_STATIC_TLS_PASSPHRASE;
    if (passphrase) {
      options.passphrase = passphrase;
    }
    return options;
  } catch (error) {
    console.error('Failed to read TLS certificate/key for the client static server.', error);
    process.exit(1);
  }
  return undefined;
}

const protocol = useHttps ? 'https' : 'http';

// Generate the config the client fetches at /client.runtime.json. This uses the
// same generator the Vite dev/preview server uses (src/config.js), so
// `pnpm start` and `pnpm dev` derive their config from one source: .env + that module.
const runtimeConfig = writeClientRuntimeConfig();
console.log(
  `Client runtime config: signaling=${runtimeConfig.signalingServer}, clientId=${runtimeConfig.clientId}, daemonId=${runtimeConfig.daemonId}`
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
  const normalized = rawPath === '/' ? '/direct-user-control.html' : rawPath;
  const relative = normalized.replace(/^\/+/, '');
  const isPublicAsset =
    relative.startsWith('vendor/') ||
    relative === 'direct-user-control.html';
  const baseDir = isPublicAsset ? path.resolve(rootDir, 'public') : rootDir;
  const candidate = path.resolve(baseDir, relative);
  if (!candidate.startsWith(path.resolve(baseDir))) {
    return null;
  }
  return candidate;
}

function handleRequest(req, res) {
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
}

const server = useHttps
  ? https.createServer(loadTlsOptions(), handleRequest)
  : http.createServer(handleRequest);

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(
      `Client static server failed to start: port ${staticPort} is already in use on ${staticHost}.`
    );
    console.error('Stop the existing process or set CLIENT_STATIC_PORT to a free port.');
    process.exit(1);
    return;
  }

  console.error('Client static server failed to start.', error);
  process.exit(1);
});

server.listen(staticPort, staticHost, () => {
  console.log(`Client static server running: ${protocol}://${staticHost}:${staticPort}`);
  console.log(`Open demo page: ${protocol}://${publicHost}:${staticPort}/direct-user-control.html`);
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
