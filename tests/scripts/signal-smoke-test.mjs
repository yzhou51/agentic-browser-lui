import process from 'node:process';
import { io } from 'socket.io-client';

const signalingUrl = process.env.SIGNALING_SERVER || 'http://localhost:8095';
const signalingPath = process.env.OWT_SIGNALING_PATH || '/socket.io';

function authClient(token) {
  return new Promise((resolve, reject) => {
    const socket = io(signalingUrl, { path: signalingPath, reconnection: false });

    socket.on('connect_error', (error) => {
      reject(error);
    });

    socket.on('connect', () => {
      socket.emit('authentication', { token }, (result) => {
        if (result?.uid === token) {
          resolve(socket);
        } else {
          reject(new Error(result?.error || 'Authentication failed.'));
        }
      });
    });
  });
}

async function main() {
  let clientA;
  let clientB;

  try {
    clientA = await authClient('signal-test-a');
    clientB = await authClient('signal-test-b');

    const receivedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for owt-message relay.')), 5000);
      clientB.on('owt-message', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const ackPromise = new Promise((resolve, reject) => {
      clientA.emit('owt-message', { to: 'signal-test-b', data: 'hello-relay' }, (err) => {
        if (err) reject(new Error(String(err)));
        else resolve();
      });
    });

    await ackPromise;
    const payload = await receivedPromise;

    if (payload?.from !== 'signal-test-a' || payload?.data !== 'hello-relay') {
      throw new Error(`Unexpected relay payload: ${JSON.stringify(payload)}`);
    }

    console.log(`Signal smoke test passed on ${signalingUrl}${signalingPath}: authentication and owt-message relay are working.`);
  } finally {
    if (clientA) clientA.close();
    if (clientB) clientB.close();
  }
}

main().catch((error) => {
  console.error(`Signal smoke test failed: ${error.message}`);
  process.exit(1);
});
