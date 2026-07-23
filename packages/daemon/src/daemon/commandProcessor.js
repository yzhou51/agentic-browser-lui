import { createLogger } from '../logger.js';

import {
  decodeMouseCommand,
  normalizeMouseCommandPayload,
} from '../../../client/src/sdk/input/mouseCommandCodec.js';

const logger = createLogger('command-processor');

// Button code constants (matches client-side values)
const BUTTON_LEFT = 0;
const BUTTON_MIDDLE = 1;
const BUTTON_RIGHT = 2;

function buttonCodeToName(buttonCode) {
  switch (Number(buttonCode ?? 0)) {
    case BUTTON_MIDDLE:
      return 'middle';
    case BUTTON_RIGHT:
      return 'right';
    default:
      return 'left';
  }
}

function normalizeButtonParameter(payload) {
  // Support both compact (b) and legacy (button) formats
  if (payload.b !== undefined) {
    return buttonCodeToName(payload.b);
  }
  if (payload.button !== undefined) {
    return payload.button;
  }
  return 'left';
}



export class CommandProcessor {
  constructor(browserController) {
    this.browser = browserController;
  }

  async handle(command) {
    if (!command || typeof command !== 'object') {
      throw new Error('Invalid command payload.');
    }

    let { type, payload = {} } = command;
    
    // Normalize payload: decode binary if needed, fall back to JSON
    payload = normalizeMouseCommandPayload(payload) || {};

    logger.debug('[daemon] command received', {
      type,
      payloadType: payload instanceof ArrayBuffer ? 'binary' : 'json',
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
        case 'capture_target_snapshot': {
          const snapshot = await this.browser.captureTargetSnapshot(payload || {});
          return {
            ok: true,
            bridge: 'puppeteer',
            ...snapshot,
          };
        }
        case 'inject_calibration_markers': {
          const result = await this.browser.injectCalibrationMarkers();
          return { ok: true, bridge: 'puppeteer', ...result };
        }
        case 'remove_calibration_markers': {
          await this.browser.removeCalibrationMarkers();
          return { ok: true, bridge: 'puppeteer' };
        }
        case 'set_calibration': {
          const applied = this.browser.setCalibration(payload.correspondences || [], {
            sourceWidth: payload.sourceWidth,
            sourceHeight: payload.sourceHeight,
          });
          return {
            ok: applied,
            message: applied ? 'Calibration applied.' : 'Calibration rejected (insufficient/degenerate points).',
          };
        }
        case 'clear_calibration': {
          this.browser.clearCalibration();
          return { ok: true };
        }
        case 'dispatch_target_command':
          return await this.browser.dispatchTargetCommand(payload.command || {});
        case 'mouse_move': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          logger.debug('[daemon] mouse_move received', {
            received: {
              x: payload.x,
              y: payload.y,
              viewWidth: payload.viewWidth,
              viewHeight: payload.viewHeight,
              viewScrollLeft: payload.viewScrollLeft,
              viewScrollTop: payload.viewScrollTop,
              sx: payload.sx,
              sy: payload.sy,
            },
            used: {
              x: payload.x,
              y: payload.y,
              sx: payload.sx,
              sy: payload.sy,
            },
            note: 'viewWidth/Height/scrollLeft/Top sent but not used for mapping (for future viewport-aware feature)',
            mapped,
          });
          await this.browser.moveMouse(mapped.x, mapped.y);
          return { ok: true, mapped };
        }
        case 'mouse_down': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          const button = normalizeButtonParameter(payload);
          logger.debug('[daemon] mouse_down', {
            payload: {
              x: payload.x,
              y: payload.y,
              sx: payload.sx,
              sy: payload.sy,
              b: payload.b,
            },
            button,
            mapped,
          });
          await this.browser.mouseDown(mapped.x, mapped.y, button);
          return { ok: true, mapped };
        }
        case 'mouse_up': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          const button = normalizeButtonParameter(payload);
          logger.debug('[daemon] mouse_up', {
            payload: {
              x: payload.x,
              y: payload.y,
              sx: payload.sx,
              sy: payload.sy,
              b: payload.b,
            },
            button,
            mapped,
          });
          await this.browser.mouseUp(mapped.x, mapped.y, button);
          return { ok: true, mapped };
        }
        case 'mouse_click': {
          const mapped = await this.browser.resolveTargetCoordinates(payload);
          const button = normalizeButtonParameter(payload);
          await this.browser.clickMouse(mapped.x, mapped.y, button);
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
