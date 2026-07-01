import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: ['VITE_', 'SIGNALING_', 'DAEMON_', 'CLIENT_'],
  server: {
    port: 5173,
    host: true,
  },
});
