import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  signalingServer: process.env.SIGNALING_SERVER || 'http://localhost:8095',
  daemonId: process.env.DAEMON_ID || 'daemon-1',
  defaultClientId: process.env.CLIENT_ID || 'client-1',
  staticServerHost: process.env.DAEMON_STATIC_HOST || '0.0.0.0',
  staticServerPort: Number(process.env.DAEMON_STATIC_PORT || 8788),
  browserHeadless: (process.env.BROWSER_HEADLESS || 'false').toLowerCase() === 'true',
};
