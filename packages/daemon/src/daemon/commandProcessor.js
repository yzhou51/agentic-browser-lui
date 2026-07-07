import { createLogger } from '../logger.js';

const logger = createLogger('command-processor');

export class CommandProcessor {
  constructor(browserController) {
    this.browser = browserController;
  }

  async handle(command) {
    if (!command || typeof command !== 'object') {
      throw new Error('Invalid command payload.');
    }

    const { type, payload = {} } = command;

    logger.debug('[daemon] command received', {
      type,
      payload,
      requestId: command.requestId,
    });

    try {
      switch (type) {
        case 'launch_chrome':
          this.browser.configureLaunch(payload || {});
          await this.browser.launchIfNeeded();
          return { ok: true, message: 'Chrome launched.' };
        case 'open_url':
          await this.browser.open(payload.url);
          return { ok: true, message: `Opened ${payload.url}` };
        case 'open_target_page': {
          const result = await this.browser.openTarget(payload.url);
          return {
            ok: true,
            message: `Opened target page ${payload.url}`,
            targetPage: result,
            bridge: 'puppeteer',
          };
        }
        case 'prepare_share_target': {
          const result = await this.browser.prepareShareTarget();
          return {
            ok: true,
            message: result ? 'Prepared target page for sharing.' : 'No Puppeteer target page is open to prepare.',
            targetPage: result,
            bridge: 'puppeteer',
          };
        }
        case 'close_target_page': {
          await this.browser.closeTargetPage();
          return { ok: true, message: 'Target page closed.', bridge: 'puppeteer' };
        }
        case 'dispatch_target_command':
          return await this.browser.dispatchTargetCommand(payload.command || {});
        case 'mouse_move': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          await this.browser.moveMouse(mapped.x, mapped.y);
          return { ok: true, mapped };
        }
        case 'mouse_down': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          await this.browser.mouseDown(mapped.x, mapped.y, payload.button || 'left');
          return { ok: true, mapped };
        }
        case 'mouse_up': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          await this.browser.mouseUp(mapped.x, mapped.y, payload.button || 'left');
          return { ok: true, mapped };
        }
        case 'mouse_click': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          await this.browser.clickMouse(mapped.x, mapped.y, payload.button || 'left');
          return { ok: true, mapped };
        }
        case 'text_input':
          await this.browser.inputText(payload.text || '');
          return { ok: true };
        case 'key_press':
          if (payload.key === 'Backspace') {
            await this.browser.deleteBackward();
          } else {
            await this.browser.pressKey(payload.key);
          }
          return { ok: true };
        case 'close_page':
          await this.browser.closePage();
          return { ok: true, message: 'Page closed.' };
        case 'exit_chrome':
          await this.browser.closeBrowser();
          return { ok: true, message: 'Chrome exited.' };
        default:
          throw new Error(`Unsupported command type: ${type}`);
      }
    } catch (error) {
      logger.error('[daemon] command failed', {
        type,
        payload,
        requestId: command.requestId,
        error: error.message,
      });
      throw error;
    }
  }
}
