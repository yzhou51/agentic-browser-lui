import { createLogger } from '../logger.js';

const logger = createLogger('input-controller');

// Replays pointer/keyboard input onto whatever page is currently the active
// control target. Constructed with a `getActiveControlPage()` accessor so it
// never needs to know how pages are managed.
export class InputController {
  constructor({ getActiveControlPage }) {
    if (typeof getActiveControlPage !== 'function') {
      throw new Error('InputController requires a getActiveControlPage() accessor.');
    }
    this.getActiveControlPage = getActiveControlPage;
  }

  async moveMouse(x, y) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
  }

  async mouseDown(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.down({ button });
  }

  async mouseUp(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.up({ button });
  }

  async clickMouse(x, y, button = 'left') {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.mouse.click(Number(x), Number(y), { button });
  }

  async inputText(text) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.keyboard.type(String(text));
  }

  async pressKey(key) {
    const page = this.getActiveControlPage();
    if (!page) return;
    await page.keyboard.press(String(key));
  }

  async deleteBackward() {
    const page = this.getActiveControlPage();
    if (!page) return;

    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('No open page is available for Backspace.');
    }

    logger.debug('Deleting backward in active page.');

    try {
      await page.bringToFront();
    } catch (error) {
      logger.warn(`bringToFront before Backspace failed: ${error.message}`);
    }

    try {
      await page.keyboard.press('Backspace');
    } catch (error) {
      logger.error(`Backspace press failed: ${error.message}`);
      throw error;
    }
  }
}
