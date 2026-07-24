import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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

function resolveSafePath(rootDir, browserModuleDir, clientSdkDir, reqPath) {
  const rawPath = decodeURIComponent(reqPath.split('?')[0]);
  if (rawPath.startsWith('/daemon-src/')) {
    const relativeModulePath = rawPath.replace(/^\/daemon-src\//, '');
    const candidate = path.resolve(browserModuleDir, relativeModulePath);
    if (!candidate.startsWith(path.resolve(browserModuleDir))) {
      return null;
    }
    return candidate;
  }
  if (clientSdkDir && rawPath.startsWith('/client-sdk/')) {
    const relativeModulePath = rawPath.replace(/^\/client-sdk\//, '');
    const candidate = path.resolve(clientSdkDir, relativeModulePath);
    if (!candidate.startsWith(path.resolve(clientSdkDir))) {
      return null;
    }
    return candidate;
  }

  const normalized = rawPath === '/' ? '/daemon.html' : rawPath;
  const relative = normalized.replace(/^\/+/, '');
  const candidate = path.resolve(rootDir, relative);
  if (!candidate.startsWith(path.resolve(rootDir))) {
    return null;
  }
  return candidate;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON payload.'));
      }
    });

    req.on('error', reject);
  });
}

function writeJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function withCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function startStaticServer({
  rootDir,
  browserModuleDir,
  clientSdkDir,
  host,
  port,
  getDaemonConfig,
  submitCommand,
  getDaemonPageCommands,
  onDaemonPageEvent,
}) {

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (req.method === 'OPTIONS' && req.url.startsWith('/api/v1/')) {
      withCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/daemon.config.json') {
      writeJson(res, 200, getDaemonConfig());
      return;
    }

    if (req.url === '/daemon.command') {
      if (req.method !== 'POST') {
        res.writeHead(405, {
          'Content-Type': 'application/json; charset=utf-8',
          Allow: 'POST',
        });
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
        return;
      }

      readJsonBody(req)
        .then(async (payload) => {
          const result = await submitCommand(payload);
          writeJson(res, 200, result);
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Command failed.' });
        });
      return;
    }

    if (req.url.startsWith('/api/v1/page/commands') && req.method === 'GET') {
      withCorsHeaders(res);
      const url = new URL(req.url, 'http://localhost');
      const after = Number(url.searchParams.get('after') || 0);
      const data = getDaemonPageCommands(after);
      writeJson(res, 200, {
        ok: true,
        ...data,
      });
      return;
    }

    if (req.url === '/api/v1/page/events' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then((payload) => {
          onDaemonPageEvent(payload);
          writeJson(res, 200, { ok: true });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Invalid event payload.' });
        });
      return;
    }

    const filePath = resolveSafePath(rootDir, browserModuleDir, clientSdkDir, req.url);
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
