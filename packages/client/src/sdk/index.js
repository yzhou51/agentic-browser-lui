export { DirectUserControlClient } from './DirectUserControlClient.js';

// Input: coordinate mapping, mouse buttons, payload building/sending, binary codec.
export {
  getRenderedVideoContentRect,
  mapPointerToVideoSpace,
} from './input/videoGeometry.js';
export {
  BUTTON_LEFT,
  BUTTON_MIDDLE,
  BUTTON_RIGHT,
  buttonNameToCode,
  buttonCodeToName,
  getPointerButtonCode,
} from './input/mouseButtons.js';
export {
  buildViewerMousePayload,
  createViewerMouseCommandSender,
} from './input/mouseCommandSender.js';
export {
  encodeMouseCommand,
  decodeMouseCommand,
} from './input/mouseCommandCodec.js';

// Config: runtime config + ICE log summary.
export { loadClientRuntimeConfig } from './config/runtimeConfig.js';
export { summarizeIceConfigForLog } from './config/rtcConfig.js';
export { createPeerIds } from './config/peerIds.js';

// URL query-string helpers for the demo pages.
export {
  hasAnySearchParam,
  readSearchParam,
  readSearchParamAny,
  readSearchPercentParam,
} from './searchParams.js';
