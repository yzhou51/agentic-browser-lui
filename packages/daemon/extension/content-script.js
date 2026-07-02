(() => {
  const BRIDGE_EVENT = 'agentic-input';
  const ACK_EVENT = 'agentic-extension-ack';
  const EXTENSION_REQUEST_EVENT = 'agentic-extension-request';
  const EXTENSION_RESPONSE_EVENT = 'agentic-extension-response';
  let activeMouseButton = 0;

  function debug(message, details) {
    if (details === undefined) {
      console.log('[agentic-extension]', message);
      return;
    }
    console.log('[agentic-extension]', message, details);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }

          resolve(response || { ok: false, error: 'No extension response received.' });
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || 'Failed to send runtime message.' });
      }
    });
  }

  function postExtensionResponse(requestId, response) {
    window.postMessage(
      {
        type: EXTENSION_RESPONSE_EVENT,
        requestId,
        response,
      },
      '*'
    );
  }

  function describeElement(element) {
    if (!element) {
      return null;
    }
    return {
      tagName: element.tagName,
      id: element.id || null,
      className: typeof element.className === 'string' ? element.className : null,
      name: element.getAttribute?.('name') || null,
      type: element.getAttribute?.('type') || null,
      role: element.getAttribute?.('role') || null,
      contentEditable: Boolean(element.isContentEditable),
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly),
    };
  }

  function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function mapRemoteCoordinates(payload = {}) {
    const sourceWidth = Math.max(1, toNumber(payload.sourceWidth, window.innerWidth || 1));
    const sourceHeight = Math.max(1, toNumber(payload.sourceHeight, window.innerHeight || 1));
    const targetWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const targetHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const x = toNumber(payload.x, 0);
    const y = toNumber(payload.y, 0);

    const mappedX = Math.max(0, Math.min(targetWidth - 1, Math.round((x / sourceWidth) * targetWidth)));
    const mappedY = Math.max(0, Math.min(targetHeight - 1, Math.round((y / sourceHeight) * targetHeight)));

    return { x: mappedX, y: mappedY };
  }

  function getFocusableEditableElement() {
    const active = document.activeElement;
    if (active && active !== document.body && (active.isContentEditable || typeof active.value === 'string')) {
      debug('using active editable element', describeElement(active));
      return active;
    }
    const fallback = document.querySelector('input, textarea, [contenteditable="true"], [contenteditable=""]');
    debug('using fallback editable element', describeElement(fallback));
    return fallback;
  }

  function emitAck({ requestId, kind, ok, message }) {
    if (!window.opener || typeof window.opener.postMessage !== 'function') {
      debug('skip ack because opener is unavailable', { requestId, kind, ok, message });
      return;
    }

    debug('emit ack', {
      requestId,
      kind,
      ok,
      message,
      href: window.location.href,
    });

    window.opener.postMessage(
      {
        type: ACK_EVENT,
        requestId,
        kind,
        ok,
        message,
        origin: window.location.origin,
        href: window.location.href,
        ts: Date.now(),
      },
      '*'
    );
  }

  function dispatchMouse(commandType, payload = {}) {
    const mapped = mapRemoteCoordinates(payload);
    const element = document.elementFromPoint(mapped.x, mapped.y);
    const button = payload.button || 'left';
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    const buttonsMask = payload.isDragging || commandType === 'mouse_down' || commandType === 'mouse_click'
      ? buttonCode === 2 ? 2 : buttonCode === 1 ? 4 : 1
      : 0;
    debug('dispatch mouse', {
      commandType,
      payload,
      mapped,
      element: describeElement(element),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      href: window.location.href,
    });
    if (!element) {
      return { ok: false, message: `No element at (${mapped.x}, ${mapped.y}).` };
    }

    if (typeof element.focus === 'function') {
      element.focus();
    }

    const moveEvent = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: mapped.x,
      clientY: mapped.y,
      button: buttonCode,
      buttons: commandType === 'mouse_up' ? 0 : buttonsMask,
      view: window,
    });
    element.dispatchEvent(moveEvent);

    if (commandType === 'mouse_move') {
      return { ok: true, message: `mouse_move replayed at (${mapped.x}, ${mapped.y}).` };
    }

    if (commandType === 'mouse_down') {
      activeMouseButton = buttonCode;
      element.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX: mapped.x,
          clientY: mapped.y,
          button: buttonCode,
          buttons: buttonsMask,
          view: window,
        })
      );
      return { ok: true, message: `mouse_down replayed at (${mapped.x}, ${mapped.y}).` };
    }

    if (commandType === 'mouse_up') {
      element.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          clientX: mapped.x,
          clientY: mapped.y,
          button: buttonCode,
          buttons: 0,
          view: window,
        })
      );
      activeMouseButton = 0;
      return { ok: true, message: `mouse_up replayed at (${mapped.x}, ${mapped.y}).` };
    }

    ['mousedown', 'mouseup', 'click'].forEach((eventType) => {
      element.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          clientX: mapped.x,
          clientY: mapped.y,
          button: buttonCode,
          buttons: eventType === 'mouseup' || eventType === 'click' ? 0 : buttonsMask,
          view: window,
        })
      );
    });

    activeMouseButton = 0;

    return { ok: true, message: `mouse_click replayed at (${mapped.x}, ${mapped.y}).` };
  }

  function dispatchTextInput(payload = {}) {
    const text = String(payload.text || '');
    const element = getFocusableEditableElement();
    debug('dispatch text input', {
      textLength: text.length,
      element: describeElement(element),
      href: window.location.href,
    });
    if (!element) {
      return { ok: false, message: 'No editable element found for text_input.' };
    }

    if (typeof element.focus === 'function') {
      element.focus();
    }

    if (typeof element.value === 'string') {
      element.value += text;
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: text,
          inputType: 'insertText',
        })
      );
      return { ok: true, message: `text_input replayed (${text.length} chars).` };
    }

    if (element.isContentEditable) {
      element.textContent = `${element.textContent || ''}${text}`;
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: text,
          inputType: 'insertText',
        })
      );
      return { ok: true, message: `text_input replayed (${text.length} chars).` };
    }

    return { ok: false, message: 'Focused element is not editable.' };
  }

  function dispatchKeyPress(payload = {}) {
    const key = String(payload.key || '');
    const element = getFocusableEditableElement();
    debug('dispatch key press', {
      key,
      element: describeElement(element),
      href: window.location.href,
    });
    if (!element) {
      return { ok: false, message: 'No editable element found for key_press.' };
    }

    if (typeof element.focus === 'function') {
      element.focus();
    }

    if (key === 'Backspace' && typeof element.value === 'string') {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (start != null && end != null) {
        if (start !== end) {
          element.setRangeText('', start, end, 'end');
        } else if (start > 0) {
          element.setRangeText('', start - 1, start, 'end');
        }
      } else if (element.value.length > 0) {
        element.value = element.value.slice(0, -1);
      }
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: null,
          inputType: 'deleteContentBackward',
        })
      );
      return { ok: true, message: 'Backspace replayed.' };
    }

    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
    element.dispatchEvent(
      new KeyboardEvent('keyup', {
        key,
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
    return { ok: true, message: `key_press replayed (${key || 'unknown'}).` };
  }

  function handleBridgeCommand(command) {
    const safeCommand = command && typeof command === 'object' ? command : {};
    const type = String(safeCommand.type || '');
    const payload = safeCommand.payload && typeof safeCommand.payload === 'object' ? safeCommand.payload : {};

    debug('handle bridge command', {
      type,
      requestId: safeCommand.requestId || null,
      payload,
      href: window.location.href,
      readyState: document.readyState,
      activeElement: describeElement(document.activeElement),
    });

    if (type === 'extension_ping') {
      return { ok: true, message: 'Extension bridge is active.' };
    }

    if (type === 'open_url') {
      const url = String(payload.url || '').trim();
      if (url) {
        window.location.href = url;
        return { ok: true, message: `Navigating to ${url}` };
      }
      return { ok: false, message: 'open_url missing payload.url.' };
    }

    if (type === 'close_page') {
      window.close();
      return { ok: true, message: 'close_page requested.' };
    }

    if (type === 'mouse_move' || type === 'mouse_down' || type === 'mouse_up' || type === 'mouse_click') {
      return dispatchMouse(type, payload);
    }

    if (type === 'text_input') {
      return dispatchTextInput(payload);
    }

    if (type === 'key_press') {
      return dispatchKeyPress(payload);
    }

    return { ok: false, message: `Unsupported command in extension bridge: ${type}` };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'agentic-run-command') {
      return false;
    }

    let result;
    try {
      result = handleBridgeCommand(message.command);
    } catch (error) {
      result = { ok: false, message: error?.message || 'Unhandled extension bridge error.' };
    }

    sendResponse({ ok: result.ok !== false, result });
    return false;
  });

  window.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data || event.source !== window) {
      return;
    }

    if (data.type === EXTENSION_REQUEST_EVENT && data.requestId) {
      sendRuntimeMessage({
        type: 'agentic-daemon-request',
        action: data.action,
        payload: data.payload,
      }).then((response) => {
        debug('daemon page extension request complete', {
          requestId: data.requestId,
          action: data.action,
          response,
        });
        postExtensionResponse(data.requestId, response);
      });
      return;
    }

    if (data.type !== BRIDGE_EVENT || !data.command) {
      return;
    }

    const requestId = String(data.command.requestId || '');
    const kind = String(data.command.type || 'unknown');

    let result;
    try {
      result = handleBridgeCommand(data.command);
    } catch (error) {
      result = { ok: false, message: error?.message || 'Unhandled extension bridge error.' };
      debug('bridge command failed', {
        requestId,
        kind,
        error: error?.message || String(error),
      });
    }

    debug('bridge command result', {
      requestId,
      kind,
      result,
    });

    if (requestId) {
      emitAck({
        requestId,
        kind,
        ok: result.ok !== false,
        message: result.message || kind,
      });
    }
  });

  debug('content script ready', {
    href: window.location.href,
    title: document.title,
  });

  sendRuntimeMessage({
    type: 'agentic-register-page',
    payload: {
      href: window.location.href,
      title: document.title,
      readyState: document.readyState,
    },
  }).then((response) => {
    debug('page registered with extension background', response);
  });

  window.addEventListener('focus', () => {
    void sendRuntimeMessage({
      type: 'agentic-register-page',
      payload: {
        href: window.location.href,
        title: document.title,
        readyState: document.readyState,
      },
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    void sendRuntimeMessage({
      type: 'agentic-register-page',
      payload: {
        href: window.location.href,
        title: document.title,
        readyState: document.readyState,
      },
    });
  });
})();
