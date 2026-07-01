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
