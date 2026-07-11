import { Command } from 'commander';

export function buildCli({ getState, submitCommand }) {
  const program = new Command();

  program
    .name('agentic-daemon')
    .description('Local CLI for daemon control')
    .version('0.1.0');

  program
    .command('state')
    .description('Show daemon runtime state')
    .action(() => {
      const state = getState();
      console.log(JSON.stringify(state, null, 2));
    });

  program
    .command('launch')
    .description('Launch local browser')
    .action(async () => {
      const result = await submitCommand({ type: 'launch_chrome' });
      console.log(result.message || 'Done.');
    });

  program
    .command('open')
    .description('Open URL in browser')
    .requiredOption('-u, --url <url>', 'URL')
    .action(async (opts) => {
      const result = await submitCommand({ type: 'open_url', payload: { url: opts.url } });
      console.log(result.message || 'Done.');
    });

  program
    .command('session-start')
    .description('Start unified daemon session workflow via daemon REST API')
    .requiredOption('--daemon-id <id>', 'daemon p2p self id')
    .requiredOption('--client-id <id>', 'client peer id')
    .requiredOption('--target-url <url>', 'target page URL')
    .option('--daemon-api-url <url>', 'daemon REST base URL', 'http://localhost:8788')
    .option('--timeout <seconds>', 'session timeout in seconds')
    .option('--session-id <id>', 'session id')
    .option('--signaling-server <url>', 'signaling server URL')
    .option('--stun-urls <csv>', 'comma-separated stun urls')
    .option('--turn-urls <csv>', 'comma-separated turn urls')
    .option('--turn-username <value>', 'turn username')
    .option('--turn-credential <value>', 'turn credential')
    .option('--chrome <path>', 'chrome executable path override')
    .option('--chrome-params <json>', 'chrome params as JSON string array')
    .action(async (opts) => {
      const daemonApiBase = String(opts.daemonApiUrl || 'http://localhost:8788').replace(/\/+$/, '');
      const payload = {
        daemonId: opts.daemonId,
        clientId: opts.clientId,
        targetUrl: opts.targetUrl,
      };

      if (opts.timeout !== undefined) {
        payload.timeout = Number(opts.timeout);
      }
      if (opts.sessionId) {
        payload.sessionId = opts.sessionId;
      }
      if (opts.signalingServer) {
        payload.signalingServer = opts.signalingServer;
      }
      if (opts.stunUrls) {
        payload.stunUrls = opts.stunUrls;
      }
      if (opts.turnUrls) {
        payload.turnUrls = opts.turnUrls;
      }
      if (opts.turnUsername) {
        payload.turnUsername = opts.turnUsername;
      }
      if (opts.turnCredential) {
        payload.turnCredential = opts.turnCredential;
      }
      if (opts.chrome) {
        payload.chrome = opts.chrome;
      }
      if (opts.chromeParams) {
        payload.chromeParams = opts.chromeParams;
      }

      const response = await fetch(`${daemonApiBase}/api/v1/session/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok === false) {
        throw new Error(result?.error || 'session-start request failed');
      }

      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('close-page')
    .description('Close current page')
    .action(async () => {
      const result = await submitCommand({ type: 'close_page' });
      console.log(result.message || 'Done.');
    });

  program
    .command('exit-chrome')
    .description('Exit local browser process')
    .action(async () => {
      const result = await submitCommand({ type: 'exit_chrome' });
      console.log(result.message || 'Done.');
    });

  return program;
}
