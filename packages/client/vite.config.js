import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { buildClientRuntimeConfig, serializeClientRuntimeConfig } from './src/runtimeConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve /client.runtime.json from the same generator `pnpm start` uses, so the
// dev/preview server and the static server share a single source of truth
// (.env + src/runtimeConfig.js) instead of a checked-in public/ copy.
function clientRuntimeConfigPlugin() {
  const handler = (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/client.runtime.json') {
      next();
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(serializeClientRuntimeConfig(buildClientRuntimeConfig()));
  };

  return {
    name: 'client-runtime-config',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [clientRuntimeConfigPlugin()],
  envPrefix: ['VITE_', 'SIGNALING_', 'DAEMON_', 'CLIENT_', 'STUN_', 'TURN_', 'RTC_'],
  build: {
    rollupOptions: {
      input: {
        mobile_client: path.resolve(__dirname, 'public/client.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
