export class CommandProcessor {
  constructor(browserController) {
    this.browser = browserController;
  }

  async handle(command) {
    if (!command || typeof command !== 'object') {
      throw new Error('Invalid command payload.');
    }

    const { type, payload = {} } = command;

    console.log('[daemon] command received', {
      type,
      payload,
      requestId: command.requestId,
    });

    try {
      switch (type) {
        case 'launch_chrome':
          await this.browser.launchIfNeeded();
          return { ok: true, message: 'Chrome launched.' };
        case 'open_url':
          await this.browser.open(payload.url);
          return { ok: true, message: `Opened ${payload.url}` };
        case 'mouse_move':
          await this.browser.moveMouse(payload.x, payload.y);
          return { ok: true };
        case 'mouse_down':
          await this.browser.mouseDown(payload.x, payload.y, payload.button || 'left');
          return { ok: true };
        case 'mouse_up':
          await this.browser.mouseUp(payload.x, payload.y, payload.button || 'left');
          return { ok: true };
        case 'mouse_click':
          await this.browser.clickMouse(payload.x, payload.y, payload.button || 'left');
          return { ok: true };
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
      console.error('[daemon] command failed', {
        type,
        payload,
        requestId: command.requestId,
        error: error.message,
      });
      throw error;
    }
  }
}
