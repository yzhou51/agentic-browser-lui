import puppeteer from 'puppeteer';

export class BrowserController {
  constructor({ headless = false } = {}) {
    this.headless = headless;
    this.browser = null;
    this.page = null;
  }

  async launchIfNeeded() {
    if (this.browser) {
      return;
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`Launching browser (headless=${this.headless})${executablePath ? ` with executable path: ${executablePath}` : ''}`);
    this.browser = await puppeteer.launch({
      headless: this.headless,
      channel: process.env.PUPPETEER_BROWSER_CHANNEL || 'chrome',
      executablePath,
      defaultViewport: { width: 1440, height: 900 },
      args: [
        '--disable-web-security',
        '--allow-http-screen-capture',
        '--auto-select-desktop-capture-source=Agentic Browser Daemon',
      ],
    });
  }

  async open(url) {
    await this.launchIfNeeded();
    if (!this.page) {
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1440, height: 900 });
      await this.page.setUserAgent('agentic-browser-daemon');
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async moveMouse(x, y) {
    if (!this.page) return;
    await this.page.mouse.move(Number(x), Number(y));
  }

  async clickMouse(x, y, button = 'left') {
    if (!this.page) return;
    await this.page.mouse.click(Number(x), Number(y), { button });
  }

  async inputText(text) {
    if (!this.page) return;
    await this.page.keyboard.type(String(text));
  }

  async pressKey(key) {
    if (!this.page) return;
    await this.page.keyboard.press(String(key));
  }

  async deleteBackward() {
    if (!this.page) return;

    if (typeof this.page.isClosed === 'function' && this.page.isClosed()) {
      throw new Error('No open page is available for Backspace.');
    }

    console.log('Deleting backward in active page.');

    try {
      await this.page.bringToFront();
    } catch (error) {
      console.log(`bringToFront before Backspace failed: ${error.message}`);
    }

    try {
      await this.page.keyboard.press('Backspace');
    } catch (error) {
      console.log(`Backspace press failed: ${error.message}`);
      throw error;
    }
  }

  async closePage() {
    if (!this.page) return;
    await this.page.close();
    this.page = null;
  }

  async closeBrowser() {
    if (!this.browser) return;
    await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}
