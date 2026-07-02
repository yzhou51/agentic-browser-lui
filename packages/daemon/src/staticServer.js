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

function resolveSafePath(rootDir, browserModuleDir, reqPath) {
  const rawPath = decodeURIComponent(reqPath.split('?')[0]);
  if (rawPath.startsWith('/daemon-src/')) {
    const relativeModulePath = rawPath.replace(/^\/daemon-src\//, '');
    const candidate = path.resolve(browserModuleDir, relativeModulePath);
    if (!candidate.startsWith(path.resolve(browserModuleDir))) {
      return null;
    }
    return candidate;
  }

  const normalized = rawPath === '/' ? '/daemon-agent.html' : rawPath;
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

export function startStaticServer({ rootDir, browserModuleDir, host, port, daemonAgentConfig, submitCommand }) {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (req.url === '/daemon-agent.config.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(daemonAgentConfig, null, 2));
      return;
    }

    if (req.url === '/daemon-agent.command') {
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
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: error.message || 'Command failed.' }));
        });
      return;
    }

    const filePath = resolveSafePath(rootDir, browserModuleDir, req.url);
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
