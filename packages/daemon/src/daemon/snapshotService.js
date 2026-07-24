import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDefaultTimeoutSnapshotDir() {
  const configured = String(process.env.DAEMON_TIMEOUT_SNAPSHOT_DIR || '').trim();
  if (configured) {
    return configured;
  }

  return path.resolve(__dirname, '../../log/snapshots');
}

// Captures screenshots of the shared target page, either as an in-memory base64
// PNG (captureTargetSnapshot) or written to disk (saveTargetSnapshotToFile, used
// for timeout/termination snapshots). Constructed with page accessors so it never
// needs to know how pages are managed.
export class SnapshotService {
  constructor({ hasTargetPage, prepareTargetPage, describeTargetPage }) {
    this.hasTargetPage = hasTargetPage;
    this.prepareTargetPage = prepareTargetPage;
    this.describeTargetPage = describeTargetPage;
  }

  async captureTargetSnapshot(options = {}) {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open.');
    }

    const page = await this.prepareTargetPage();
    const fullPage = Boolean(options.fullPage);
    const clip = options.clip && typeof options.clip === 'object' ? options.clip : null;
    const screenshotOptions = {
      type: 'png',
      fullPage,
      captureBeyondViewport: fullPage,
    };

    if (
      clip &&
      Number.isFinite(Number(clip.x)) &&
      Number.isFinite(Number(clip.y)) &&
      Number(clip.width) > 0 &&
      Number(clip.height) > 0
    ) {
      screenshotOptions.clip = {
        x: Number(clip.x),
        y: Number(clip.y),
        width: Number(clip.width),
        height: Number(clip.height),
      };
    }

    const image = await page.screenshot(screenshotOptions);
    const imageBuffer = Buffer.isBuffer(image) ? image : Buffer.from(image);
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
    }));

    return {
      mimeType: 'image/png',
      imageBase64: imageBuffer.toString('base64'),
      fullPage,
      clip: screenshotOptions.clip || null,
      viewport,
      targetPage: this.describeTargetPage(),
    };
  }

  async saveTargetSnapshotToFile(options = {}) {
    if (!this.hasTargetPage()) {
      throw new Error('No Puppeteer target page is open.');
    }

    const page = await this.prepareTargetPage();
    const fullPage = options.fullPage !== false;
    const outputDir = String(options.outputDir || resolveDefaultTimeoutSnapshotDir()).trim();
    const fileNamePrefix = String(options.fileNamePrefix || 'target-snapshot').trim() || 'target-snapshot';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.resolve(outputDir, `${fileNamePrefix}-${timestamp}.png`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await page.screenshot({
      type: 'png',
      path: outputPath,
      fullPage,
      captureBeyondViewport: fullPage,
    });

    return {
      ok: true,
      mimeType: 'image/png',
      fullPage,
      outputPath,
      targetPage: this.describeTargetPage(),
    };
  }
}
