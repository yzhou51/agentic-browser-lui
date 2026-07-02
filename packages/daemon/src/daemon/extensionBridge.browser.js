export function createExtensionBridge({ windowObject = window, onExtensionPing } = {}) {
  let requestSeq = 0;
  const pendingExtensionAcks = new Map();
  const pendingExtensionRequests = new Map();

  function createRequestId(prefix = 'ext') {
    return `${prefix}-${Date.now()}-${++requestSeq}`;
  }

  function waitForPending(map, requestId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = windowObject.setTimeout(() => {
        map.delete(requestId);
        resolve(null);
      }, timeoutMs);

      map.set(requestId, (value) => {
        windowObject.clearTimeout(timer);
        resolve(value);
      });
    });
  }

  function waitForExtensionAck(requestId, timeoutMs = 1400) {
    return waitForPending(pendingExtensionAcks, requestId, timeoutMs);
  }

  function waitForExtensionResponse(requestId, timeoutMs = 1800) {
    return waitForPending(pendingExtensionRequests, requestId, timeoutMs);
  }

  async function sendExtensionRequest(action, payload = {}, timeoutMs = 1800) {
    const requestId = createRequestId('ext-req');

    windowObject.postMessage(
      {
        type: 'agentic-extension-request',
        requestId,
        action,
        payload,
      },
      '*'
    );

    const response = await waitForExtensionResponse(requestId, timeoutMs);
    if (!response) {
      throw new Error(`Extension request timed out: ${action}`);
    }

    return response;
  }

  windowObject.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data) {
      return;
    }

    if (data.type === 'agentic-extension-response') {
      const requestId = String(data.requestId || '');
      if (!requestId) {
        return;
      }

      const complete = pendingExtensionRequests.get(requestId);
      if (complete) {
        pendingExtensionRequests.delete(requestId);
        complete(data.response);
      }
      return;
    }

    if (data.type !== 'agentic-extension-ack') {
      return;
    }

    const requestId = String(data.requestId || '');
    if (!requestId) {
      return;
    }

    const complete = pendingExtensionAcks.get(requestId);
    if (complete) {
      pendingExtensionAcks.delete(requestId);
      complete(data);
    }

    if (data.kind === 'extension_ping' && onExtensionPing) {
      onExtensionPing(data);
    }
  });

  return {
    createRequestId,
    sendExtensionRequest,
    waitForExtensionAck,
  };
}
