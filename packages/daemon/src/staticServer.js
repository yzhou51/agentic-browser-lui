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

function trimString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeIceUrlList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeIceUrlList(entry))
      .filter(Boolean);
  }

  const text = trimString(value);
  if (!text) {
    return [];
  }

  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function withIceDefaults(payload = {}, defaults = {}) {
  return {
    daemonId: trimString(payload.daemonId, trimString(defaults.daemonId)),
    clientId: trimString(payload.clientId, trimString(defaults.clientId)),
    signalingServer: trimString(payload.signalingServer, trimString(defaults.signalingServer)),
    stunUrls: normalizeIceUrlList(payload.stunUrls ?? payload.stuneUrls).length
      ? normalizeIceUrlList(payload.stunUrls ?? payload.stuneUrls)
      : normalizeIceUrlList(defaults.stunUrls ?? defaults.stuneUrls),
    turnUrls: normalizeIceUrlList(payload.turnUrls).length
      ? normalizeIceUrlList(payload.turnUrls)
      : normalizeIceUrlList(defaults.turnUrls),
    turnUsername: trimString(payload.turnUsername ?? payload.turnUser, trimString(defaults.turnUsername)),
    turnCredential: trimString(payload.turnCredential ?? payload.turnPassword, trimString(defaults.turnCredential ?? defaults.turnPassword)),
  };
}

export function startStaticServer({
  rootDir,
  browserModuleDir,
  host,
  port,
  getDaemonAgentConfig,
  submitCommand,
  getDaemonState,
  enqueueAgentCommand,
  getAgentCommandsAfter,
  onAgentEvent,
  isAgentOnline,
  bootstrapAgentBridge,
}) {
  async function ensureAgentBridgeOnline() {
    if (isAgentOnline()) {
      return { ok: true, bootstrapped: false };
    }

    if (typeof bootstrapAgentBridge !== 'function') {
      return {
        ok: false,
        error: 'daemon-agent page is offline and auto-bootstrap is not configured.',
      };
    }

    try {
      await bootstrapAgentBridge();
    } catch (error) {
      return {
        ok: false,
        error: `Failed to bootstrap daemon-agent page: ${error.message}`,
      };
    }

    const timeoutAt = Date.now() + 12000;
    while (Date.now() < timeoutAt) {
      if (isAgentOnline()) {
        return { ok: true, bootstrapped: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    return {
      ok: false,
      error: 'daemon-agent bridge did not come online in time. Check daemon Chrome window and extension state.',
    };
  }

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

    if (req.url === '/daemon-agent.config.json') {
      writeJson(res, 200, getDaemonAgentConfig());
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
          writeJson(res, 200, result);
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Command failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/status' && req.method === 'GET') {
      withCorsHeaders(res);
      writeJson(res, 200, {
        ok: true,
        daemon: getDaemonState(),
      });
      return;
    }

    if (req.url.startsWith('/api/v1/agent/ready') && req.method === 'GET') {
      withCorsHeaders(res);
      Promise.resolve()
        .then(async () => {
          const url = new URL(req.url, 'http://localhost');
          const bootstrap = ['1', 'true', 'yes'].includes(
            String(url.searchParams.get('bootstrap') || '').trim().toLowerCase()
          );

          if (!bootstrap) {
            const online = isAgentOnline();
            writeJson(res, 200, {
              ok: true,
              ready: online,
              online,
              bootstrapped: false,
              message: online ? 'agent bridge is online' : 'agent bridge is offline',
            });
            return;
          }

          const bridge = await ensureAgentBridgeOnline();
          writeJson(res, bridge.ok ? 200 : 409, {
            ok: bridge.ok,
            ready: bridge.ok,
            online: bridge.ok,
            bootstrapped: bridge.bootstrapped || false,
            message: bridge.ok ? 'agent bridge is online' : bridge.error,
          });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Agent ready check failed.' });
        });
      return;
    }

    if (req.url.startsWith('/api/v1/agent/commands') && req.method === 'GET') {
      withCorsHeaders(res);
      const url = new URL(req.url, 'http://localhost');
      const after = Number(url.searchParams.get('after') || 0);
      const data = getAgentCommandsAfter(after);
      writeJson(res, 200, {
        ok: true,
        ...data,
      });
      return;
    }

    if (req.url === '/api/v1/agent/events' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then((payload) => {
          onAgentEvent(payload);
          writeJson(res, 200, { ok: true });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Invalid event payload.' });
        });
      return;
    }

    if (req.url === '/api/v1/chrome/launch' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then(async (payload) => {
          const result = await submitCommand({ type: 'launch_chrome', payload });

          writeJson(res, 200, {
            ok: true,
            result,
            message: 'Chrome launched. daemon-agent page can be auto-bootstrapped by action/share APIs when needed.',
          });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Launch failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/chrome/exit' && req.method === 'POST') {
      withCorsHeaders(res);
      submitCommand({ type: 'exit_chrome' })
        .then((result) => {
          writeJson(res, 200, { ok: true, result });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Exit failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/page/open' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then(async (payload) => {
          const url = String(payload.url || '').trim();
          if (!url) {
            writeJson(res, 400, { ok: false, error: 'url is required.' });
            return;
          }

          if (String(payload.name || '').trim() === 'agent-target') {
            const agentConfig = typeof getDaemonAgentConfig === 'function' ? getDaemonAgentConfig() : {};
            const sessionConfig = withIceDefaults(payload, agentConfig);

            enqueueAgentCommand('set_session', {
              daemonId: sessionConfig.daemonId,
              clientId: sessionConfig.clientId,
              signalingServer: sessionConfig.signalingServer,
              stunUrls: sessionConfig.stunUrls,
              turnUrls: sessionConfig.turnUrls,
              turnUsername: sessionConfig.turnUsername,
              turnCredential: sessionConfig.turnCredential,
            });

            const openHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
            const daemonAgentUrl = new URL(`http://${openHost}:${port}/daemon-agent.html`);
            daemonAgentUrl.searchParams.set('uid', sessionConfig.daemonId);
            daemonAgentUrl.searchParams.set('remote', sessionConfig.clientId);
            daemonAgentUrl.searchParams.set('host', sessionConfig.signalingServer);
            if (sessionConfig.stunUrls.length) {
              daemonAgentUrl.searchParams.set('stunUrls', sessionConfig.stunUrls.join(','));
            }
            if (sessionConfig.turnUrls.length) {
              daemonAgentUrl.searchParams.set('turnUrls', sessionConfig.turnUrls.join(','));
            }
            if (sessionConfig.turnUsername) {
              daemonAgentUrl.searchParams.set('turnUsername', sessionConfig.turnUsername);
            }
            if (sessionConfig.turnCredential) {
              daemonAgentUrl.searchParams.set('turnCredential', sessionConfig.turnCredential);
            }

            await submitCommand({
              type: 'open_url',
              payload: { url: daemonAgentUrl.toString() },
            });
          }

          const result = await submitCommand({
            type: 'open_target_page',
            payload: {
              name: payload.name || '',
              url,
            },
          });
          writeJson(res, 200, { ok: true, result });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Open page failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/page/close' && req.method === 'POST') {
      withCorsHeaders(res);
      submitCommand({ type: 'close_target_page', payload: {} })
        .then((result) => {
          writeJson(res, 200, { ok: true, result });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Close page failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/share/start' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then(async (payload) => {
          const bridge = await ensureAgentBridgeOnline();
          if (!bridge.ok) {
            writeJson(res, 409, {
              ok: false,
              error: bridge.error,
            });
            return;
          }

          const daemonId = String(payload.daemonId || '').trim();
          const clientId = String(payload.clientId || '').trim();
          const signalingServer = String(payload.signalingServer || '').trim();
          const stunUrls = payload.stunUrls ?? payload.stuneUrls ?? '';
          const turnUrls = payload.turnUrls ?? '';
          const turnUsername = payload.turnUsername ?? payload.turnUser ?? '';
          const turnCredential = payload.turnCredential ?? payload.turnPassword ?? '';

          if (!daemonId || !clientId) {
            writeJson(res, 400, { ok: false, error: 'daemonId and clientId are required.' });
            return;
          }

          const setSession = enqueueAgentCommand('set_session', {
            daemonId,
            clientId,
            signalingServer,
            stunUrls,
            turnUrls,
            turnUsername,
            turnCredential,
          });
          const connectAndShare = enqueueAgentCommand('connect_share', {
            daemonId,
            clientId,
            signalingServer,
            stunUrls,
            turnUrls,
            turnUsername,
            turnCredential,
            automated: true,
          });

          writeJson(res, 200, {
            ok: true,
            commandIds: [setSession.id, connectAndShare.id],
            bootstrappedAgent: bridge.bootstrapped,
          });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Share start failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/action/request' && req.method === 'POST') {
      withCorsHeaders(res);
      readJsonBody(req)
        .then(async (payload) => {
          const bridge = await ensureAgentBridgeOnline();
          if (!bridge.ok) {
            writeJson(res, 409, {
              ok: false,
              error: bridge.error,
            });
            return;
          }

          const daemonId = String(payload.daemonId || '').trim();
          const clientId = String(payload.clientId || '').trim();
          const signalingServer = String(payload.signalingServer || '').trim();
          const targetUrl = String(payload.targetUrl || '').trim();
          const stunUrls = payload.stunUrls ?? payload.stuneUrls ?? '';
          const turnUrls = payload.turnUrls ?? '';
          const turnUsername = payload.turnUsername ?? payload.turnUser ?? '';
          const turnCredential = payload.turnCredential ?? payload.turnPassword ?? '';

          if (!daemonId || !clientId) {
            writeJson(res, 400, { ok: false, error: 'daemonId and clientId are required.' });
            return;
          }

          const requestId = `action-${Date.now()}`;
          const setSession = enqueueAgentCommand('set_session', {
            daemonId,
            clientId,
            signalingServer,
            stunUrls,
            turnUrls,
            turnUsername,
            turnCredential,
          });
          const resetConnection = enqueueAgentCommand('disconnect', {
            reason: 'take_action_reset',
            requestId,
          });
          const connectOnly = enqueueAgentCommand('connect_only', {
            daemonId,
            clientId,
            signalingServer,
            stunUrls,
            turnUrls,
            turnUsername,
            turnCredential,
            requestId,
            forceReconnect: true,
          });

          writeJson(res, 200, {
            ok: true,
            requestId,
            commandIds: [setSession.id, resetConnection.id, connectOnly.id],
            bootstrappedAgent: bridge.bootstrapped,
          });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Take Action request failed.' });
        });
      return;
    }

    if (req.url === '/api/v1/share/stop' && req.method === 'POST') {
      withCorsHeaders(res);
      ensureAgentBridgeOnline()
        .then((bridge) => {
          if (!bridge.ok) {
            writeJson(res, 409, {
              ok: false,
              error: bridge.error,
            });
            return;
          }

          const command = enqueueAgentCommand('disconnect', {});
          writeJson(res, 200, { ok: true, commandId: command.id, bootstrappedAgent: bridge.bootstrapped });
        })
        .catch((error) => {
          writeJson(res, 400, { ok: false, error: error.message || 'Share stop failed.' });
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
