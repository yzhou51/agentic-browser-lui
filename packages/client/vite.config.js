import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  envPrefix: ['VITE_', 'SIGNALING_', 'DAEMON_', 'CLIENT_', 'STUN_', 'TURN_', 'RTC_'],
  build: {
    rollupOptions: {
      input: {
        client: path.resolve(__dirname, 'client.html'),
        agent: path.resolve(__dirname, 'agent.html'),
        mobile_client: path.resolve(__dirname, 'mobile_client.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
