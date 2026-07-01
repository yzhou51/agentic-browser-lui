/* global Owt */

async function loadRuntimeConfig() {
  try {
    const response = await fetch('/daemon-agent.config.json', { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

(async function () {
  console.debug('[daemon-agent] script init');

  const params = new URLSearchParams(window.location.search);
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const uidInput = document.getElementById('uid');
  const remoteInput = document.getElementById('remote');
  const hostInput = document.getElementById('host');
  const shareBtn = document.getElementById('share');
  const targetUrlInput = document.getElementById('targetUrl');
  const openTargetBtn = document.getElementById('openTarget');
  const openTargetTabBtn = document.getElementById('openTargetTab');
  const targetFrame = document.getElementById('targetFrame');
  const runtimeConfig = await loadRuntimeConfig();

  uidInput.value = params.get('uid') || runtimeConfig.daemonId || uidInput.value;
  remoteInput.value = params.get('remote') || runtimeConfig.clientId || remoteInput.value;
  hostInput.value = params.get('host') || runtimeConfig.signalingServer || hostInput.value;

  let p2p = null;
  let screenStream = null;
  let targetTabWindow = null;

  function setStatus(text) {
    statusEl.textContent = text;
    console.log(text);
  }

  function appendMessage(message) {
    messagesEl.textContent += `${message}\n`;
  }

  function getScreenShareUnavailableReason() {
    if (!window.isSecureContext) {
      return 'Screen share requires a secure page context. Open daemon-agent via https:// or http://localhost.';
    }
    if (!navigator.mediaDevices) {
      return 'Screen share is unavailable because navigator.mediaDevices is missing in this browser/context.';
    }
    if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return 'Screen share is unavailable because this browser does not expose getDisplayMedia.';
    }
    return null;
  }

  function getTargetDocument() {
    try {
      return targetFrame.contentDocument;
    } catch {
      return null;
    }
  }

  function getTargetWindow() {
    try {
      return targetFrame.contentWindow;
    } catch {
      return null;
    }
  }

  function normalizeTargetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) {
      return '/target-demo.html';
    }
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
      return raw;
    }
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    return `https://${raw}`;
  }

  function mapRemoteCoordinates(payload = {}) {
    const sourceWidth = Number(payload.sourceWidth || targetFrame.clientWidth || 1);
    const sourceHeight = Number(payload.sourceHeight || targetFrame.clientHeight || 1);
    const targetWidth = Math.max(1, targetFrame.clientWidth);
    const targetHeight = Math.max(1, targetFrame.clientHeight);
    const x = Number(payload.x || 0);
    const y = Number(payload.y || 0);

    const mappedX = Math.max(0, Math.min(targetWidth - 1, Math.round((x / sourceWidth) * targetWidth)));
    const mappedY = Math.max(0, Math.min(targetHeight - 1, Math.round((y / sourceHeight) * targetHeight)));

    return { x: mappedX, y: mappedY, targetWidth, targetHeight };
  }

  function mapRemoteCoordinatesToTab(payload = {}, targetWin) {
    const sourceWidth = Number(payload.sourceWidth || targetFrame.clientWidth || targetWin.innerWidth || 1);
    const sourceHeight = Number(payload.sourceHeight || targetFrame.clientHeight || targetWin.innerHeight || 1);
    const targetWidth = Math.max(1, Number(targetWin.innerWidth || targetFrame.clientWidth || 1));
    const targetHeight = Math.max(1, Number(targetWin.innerHeight || targetFrame.clientHeight || 1));
    const x = Number(payload.x || 0);
    const y = Number(payload.y || 0);

    const mappedX = Math.max(0, Math.min(targetWidth - 1, Math.round((x / sourceWidth) * targetWidth)));
    const mappedY = Math.max(0, Math.min(targetHeight - 1, Math.round((y / sourceHeight) * targetHeight)));

    return { x: mappedX, y: mappedY, targetWidth, targetHeight };
  }

  function dispatchMouse(targetDoc, targetWin, type, x, y, button = 'left') {
    const targetEl = targetDoc.elementFromPoint(x, y);
    if (!targetEl) {
      return false;
    }
    if (typeof targetEl.focus === 'function') {
      targetEl.focus();
    }
    const event = new targetWin.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: button === 'right' ? 2 : button === 'middle' ? 1 : 0,
      view: targetWin,
    });
    targetEl.dispatchEvent(event);
    return true;
  }

  async function openTarget(url) {
    const normalizedUrl = normalizeTargetUrl(url);
    targetUrlInput.value = normalizedUrl;

    if (targetTabWindow && !targetTabWindow.closed) {
      try {
        targetTabWindow.location.href = normalizedUrl;
        targetTabWindow.focus();
        setStatus(`Target tab navigated to: ${normalizedUrl}`);
        return { ok: true, message: `Target tab navigated: ${normalizedUrl}` };
      } catch (error) {
        console.debug('[daemon-agent] openTarget tab navigation failed, reopening tab', error);
      }
    }

    targetTabWindow = window.open(normalizedUrl, '_blank');
    if (!targetTabWindow) {
      throw new Error('Popup blocked. Allow popups to open the target tab.');
    }
    targetTabWindow.focus();
    setStatus(`Opened target in new tab: ${normalizedUrl}`);

    return { ok: true, message: `Target page opened in new tab: ${normalizedUrl}` };
  }

  function openTargetInNewTab(url) {
    const normalizedUrl = normalizeTargetUrl(url);
    targetUrlInput.value = normalizedUrl;
    targetTabWindow = window.open(normalizedUrl, '_blank');
    setStatus(`Opened target in new tab: ${normalizedUrl}`);
  }

  function forwardCommandToTargetTab(command) {
    const { type, payload = {} } = command;

    console.debug('[daemon-agent] forwardCommandToTargetTab start', {
      type,
      payload,
      hasTargetTab: Boolean(targetTabWindow && !targetTabWindow.closed),
    });

    if (!targetTabWindow || targetTabWindow.closed) {
      console.debug('[daemon-agent] forwardCommandToTargetTab aborted: target tab missing/closed', { type });
      return { ok: false, error: 'Target tab is not open. Use Open In New Tab first.' };
    }

    try {
      console.debug('[daemon-agent] forwardCommandToTargetTab postMessage', { type, payload });
      targetTabWindow.postMessage({ type: 'agentic-input', command, ts: Date.now() }, '*');

      const targetDoc = targetTabWindow.document;
      const targetWin = targetTabWindow;
      targetDoc.dispatchEvent(
        new targetWin.CustomEvent('agentic-input', {
          detail: { command, ts: Date.now() },
        })
      );

      if (type === 'open_url') {
        const url = normalizeTargetUrl(payload.url || targetUrlInput.value);
        console.debug('[daemon-agent] forwardCommandToTargetTab open_url', { url });
        targetWin.location.href = url;
        return { ok: true, message: `open_url sent to target tab: ${url}` };
      }

      if (type === 'close_page') {
        console.debug('[daemon-agent] forwardCommandToTargetTab close_page');
        targetTabWindow.close();
        targetTabWindow = null;
        return { ok: true, message: 'Target tab closed.' };
      }

      if (type === 'text_input') {
        const text = String(payload.text || '');
        console.debug('[daemon-agent] forwardCommandToTargetTab text_input', { text, textLength: text.length });

        let el = targetDoc.activeElement;
        if (!el || el === targetDoc.body) {
          el = targetDoc.querySelector('input, textarea, [contenteditable="true"]');
        }
        if (!el) {
          console.debug('[daemon-agent] forwardCommandToTargetTab text_input: no editable element found');
          return { ok: true, message: 'text_input message sent to target tab via postMessage/custom event.' };
        }

        if (typeof el.focus === 'function') {
          el.focus();
        }

        if (typeof el.value === 'string') {
          el.value += text;
          console.debug('[daemon-agent] forwardCommandToTargetTab text_input applied to value field', {
            tagName: el.tagName,
            id: el.id,
            valueLength: el.value.length,
          });
          el.dispatchEvent(
            new targetWin.InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            })
          );
          return { ok: true, message: `text_input replayed in target tab (${text.length} chars).` };
        }

        if (el.isContentEditable) {
          el.textContent = `${el.textContent || ''}${text}`;
          console.debug('[daemon-agent] forwardCommandToTargetTab text_input applied to contenteditable', {
            tagName: el.tagName,
            id: el.id,
            textLength: el.textContent.length,
          });
          el.dispatchEvent(
            new targetWin.InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            })
          );
          return { ok: true, message: `text_input replayed in target tab (${text.length} chars).` };
        }

        return { ok: true, message: 'text_input message sent to target tab via postMessage/custom event.' };
      }

      if (type === 'key_press') {
        const key = String(payload.key || '');
        console.debug('[daemon-agent] forwardCommandToTargetTab key_press', { key });

        const arrowKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

        let el = targetDoc.activeElement;
        if (!el || el === targetDoc.body) {
          el = targetDoc.querySelector('input, textarea, [contenteditable="true"]');
        }

        if (!el) {
          return { ok: false, error: 'No editable element found for key_press in target tab.' };
        }

        if (typeof el.focus === 'function') {
          el.focus();
        }

        if (key === 'Backspace') {
          if (typeof el.value === 'string') {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (start != null && end != null) {
              if (start !== end) {
                el.setRangeText('', start, end, 'end');
              } else if (start > 0) {
                el.setRangeText('', start - 1, start, 'end');
              }
            } else if (el.value.length > 0) {
              el.value = el.value.slice(0, -1);
            }

            el.dispatchEvent(
              new targetWin.InputEvent('input', {
                bubbles: true,
                data: null,
                inputType: 'deleteContentBackward',
              })
            );
            return { ok: true, message: 'Backspace replayed in target tab input.' };
          }

          if (el.isContentEditable) {
            targetDoc.execCommand('delete');
            return { ok: true, message: 'Backspace replayed in target tab contenteditable.' };
          }
        }

        if (arrowKeys.has(key)) {
          if (typeof el.value === 'string') {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (start != null && end != null) {
              let nextPos = start;

              if (key === 'ArrowLeft') {
                nextPos = start !== end ? start : Math.max(0, start - 1);
              } else if (key === 'ArrowRight') {
                nextPos = start !== end ? end : Math.min(el.value.length, end + 1);
              } else if (key === 'ArrowUp') {
                if (el.tagName === 'TEXTAREA') {
                  const lineStart = el.value.lastIndexOf('\n', start - 1) + 1;
                  const col = start - lineStart;
                  if (lineStart > 0) {
                    const prevLineEnd = lineStart - 1;
                    const prevLineStart = el.value.lastIndexOf('\n', prevLineEnd - 1) + 1;
                    const prevLineLen = prevLineEnd - prevLineStart;
                    nextPos = prevLineStart + Math.min(col, prevLineLen);
                  } else {
                    nextPos = 0;
                  }
                } else {
                  nextPos = 0;
                }
              } else if (key === 'ArrowDown') {
                if (el.tagName === 'TEXTAREA') {
                  const lineStart = el.value.lastIndexOf('\n', start - 1) + 1;
                  const col = start - lineStart;
                  const lineEnd = el.value.indexOf('\n', start);
                  if (lineEnd >= 0) {
                    const nextLineStart = lineEnd + 1;
                    const nextLineEndIndex = el.value.indexOf('\n', nextLineStart);
                    const nextLineEnd = nextLineEndIndex >= 0 ? nextLineEndIndex : el.value.length;
                    const nextLineLen = nextLineEnd - nextLineStart;
                    nextPos = nextLineStart + Math.min(col, nextLineLen);
                  } else {
                    nextPos = el.value.length;
                  }
                } else {
                  nextPos = el.value.length;
                }
              }

              el.setSelectionRange(nextPos, nextPos, 'none');
              return { ok: true, message: `${key} replayed in target tab input.` };
            }
          }

          if (el.isContentEditable) {
            const selection = targetWin.getSelection();
            const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? 'backward' : 'forward';
            selection.modify('move', direction, key === 'ArrowLeft' || key === 'ArrowRight' ? 'character' : 'line');
            return { ok: true, message: `${key} replayed in target tab contenteditable.` };
          }
        }

        el.dispatchEvent(
          new targetWin.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            view: targetWin,
          })
        );
        el.dispatchEvent(
          new targetWin.KeyboardEvent('keyup', {
            key,
            bubbles: true,
            cancelable: true,
            view: targetWin,
          })
        );
        return { ok: true, message: `key_press replayed in target tab (${key || 'unknown'}).` };
      }

      if (type === 'mouse_move' || type === 'mouse_click') {
        const mapped = mapRemoteCoordinatesToTab(payload, targetWin);
        console.debug('[daemon-agent] forwardCommandToTargetTab mouse coords mapped', {
          type,
          payload,
          mapped,
        });

        const el = targetDoc.elementFromPoint(mapped.x, mapped.y);
        if (!el) {
          console.debug('[daemon-agent] forwardCommandToTargetTab mouse: no element at point', mapped);
          return { ok: true, message: `${type} message sent to target tab via postMessage/custom event.` };
        }

        if (typeof el.focus === 'function') {
          el.focus();
        }

        const button = payload.button || 'left';
        const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;

        el.dispatchEvent(
          new targetWin.MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: mapped.x,
            clientY: mapped.y,
            button: buttonCode,
            view: targetWin,
          })
        );
        console.debug('[daemon-agent] forwardCommandToTargetTab mouse_move dispatched', {
          tagName: el.tagName,
          id: el.id,
          x: mapped.x,
          y: mapped.y,
        });

        if (type === 'mouse_click') {
          el.dispatchEvent(
            new targetWin.MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              view: targetWin,
            })
          );
          el.dispatchEvent(
            new targetWin.MouseEvent('mouseup', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              view: targetWin,
            })
          );
          el.dispatchEvent(
            new targetWin.MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              view: targetWin,
            })
          );
          console.debug('[daemon-agent] forwardCommandToTargetTab mouse_click dispatched', {
            tagName: el.tagName,
            id: el.id,
            x: mapped.x,
            y: mapped.y,
            button,
          });
        }

        return { ok: true, message: `${type} replayed in target tab at (${mapped.x}, ${mapped.y}).` };
      }

      return { ok: true, message: `${type} sent to target tab via postMessage/custom event.` };
    } catch (error) {
      console.debug('[daemon-agent] forwardCommandToTargetTab fallback only', { type, error: error.message });
      return {
        ok: true,
        message: `${type} sent to target tab via postMessage fallback only (${error.message}).`,
      };
    }
  }

  async function handleCommand(command) {
    const { type, payload = {} } = command;
    console.log('[daemon-agent] handleCommand received', {
      type,
      payload,
      requestId: command?.requestId,
    });

    switch (type) {
      case 'open_url':
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand route to target tab', { type });
          return forwardCommandToTargetTab(command);
        }
        return openTarget(payload.url || targetUrlInput.value);
      case 'close_page':
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand route to target tab', { type });
          return forwardCommandToTargetTab(command);
        }
        return openTarget('about:blank');
      case 'mouse_move':
        console.debug('[daemon-agent] handleCommand mouse_move', { payload });
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand mouse_move -> target tab');
          return forwardCommandToTargetTab(command);
        }
        return { ok: false, error: 'No target tab is open. Use Open In New Tab first.' };
      case 'mouse_click':
        console.debug('[daemon-agent] handleCommand mouse_click', { payload });
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand mouse_click -> target tab');
          return forwardCommandToTargetTab(command);
        }
        return { ok: false, error: 'No target tab is open. Use Open In New Tab first.' };
      case 'text_input':
        console.debug('[daemon-agent] handleCommand text_input', { payload });
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand text_input -> target tab');
          return forwardCommandToTargetTab(command);
        }
        return { ok: false, error: 'No target tab is open. Use Open In New Tab first.' };
      case 'key_press':
        console.debug('[daemon-agent] handleCommand key_press', { payload });
        if (targetTabWindow && !targetTabWindow.closed) {
          console.debug('[daemon-agent] handleCommand key_press -> target tab');
          return forwardCommandToTargetTab(command);
        }
        return { ok: false, error: 'No target tab is open. Use Open In New Tab first.' };
      case 'launch_chrome':
      case 'exit_chrome':
        return { ok: false, error: `${type} is not used in daemon-agent embedded-target demo.` };
      default:
        return { ok: false, error: `Unsupported command type: ${type}` };
    }
  }

  async function connect() {
    const daemonId = uidInput.value.trim();
    const remoteId = remoteInput.value.trim();
    const signalingHost = hostInput.value.trim();

    console.debug('[daemon-agent] connect() called', { daemonId, remoteId, signalingHost });

    if (!daemonId) {
      throw new Error('Daemon ID is required.');
    }
    if (!remoteId) {
      throw new Error('Client ID is required.');
    }
    if (!signalingHost) {
      throw new Error('Signaling host is required.');
    }

    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }

    const signaling = new window.SignalingChannel();
    p2p = new Owt.P2P.P2PClient({ rtcConfiguration: {} }, signaling);
    p2p.allowedRemoteIds = [remoteId];

    console.debug('[daemon-agent] connecting', {
      daemonId,
      remoteId,
      signalingHost,
      allowedRemoteIds: p2p.allowedRemoteIds,
    });

    p2p.addEventListener('serverdisconnected', () => {
      setStatus('Disconnected from signaling server.');
    });

    p2p.addEventListener('messagereceived', async (e) => {
      console.debug('[daemon-agent] message received', {
        origin: e.origin,
        message: e.message,
      });
      appendMessage(`from ${e.origin}: ${e.message}`);

      try {
        const command = JSON.parse(e.message);
        const body = await handleCommand(command);
        await p2p.send(
          e.origin,
          JSON.stringify({
            type: 'command_result',
            requestId: command.requestId,
            ok: body.ok !== false,
            result: body,
          })
        );
      } catch (error) {
        appendMessage(`command error: ${error.message}`);
        try {
          await p2p.send(
            e.origin,
            JSON.stringify({
              type: 'command_result',
              ok: false,
              error: error.message,
            })
          );
        } catch {
          // Ignore secondary send failures.
        }
      }
    });

    await p2p.connect({ host: signalingHost, token: daemonId });
    uidInput.disabled = true;
    setStatus(`Connected as ${daemonId}. Waiting for ${remoteId} messages.`);
  }

  async function shareScreen() {
    console.log('[daemon-agent] shareScreen called');
    if (!p2p) {
      setStatus('Connect first.');
      return;
    }

    const unavailableReason = getScreenShareUnavailableReason();
    if (unavailableReason) {
      setStatus(`Share error: ${unavailableReason}`);
      return;
    }

    if (screenStream && screenStream.mediaStream) {
      screenStream.mediaStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }

    let mediaStream;
    try {
      if (targetTabWindow && !targetTabWindow.closed && targetTabWindow !== window) {
        setStatus('Please select the opened target tab in the browser picker to share it.');
      }
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
      });
    } catch (error) {
      setStatus(`Share error: ${error.message}`);
      return;
    }

    screenStream = new Owt.Base.LocalStream(
      mediaStream,
      new Owt.Base.StreamSourceInfo('screen-cast', 'screen-cast')
    );
    await p2p.publish(remoteInput.value.trim(), screenStream);
    setStatus('Screen stream published.');
  }

  const initialScreenShareReason = getScreenShareUnavailableReason();
  if (initialScreenShareReason) {
    shareBtn.title = initialScreenShareReason;
    setStatus(`Share unavailable: ${initialScreenShareReason}`);
  }

  async function disconnect() {
    if (p2p) {
      p2p.disconnect();
      p2p = null;
    }
    uidInput.disabled = false;
    setStatus('Disconnected.');
  }

  document.getElementById('connect').addEventListener('click', () => {
    console.debug('[daemon-agent] Connect button clicked');
    setStatus('Connecting...');
    connect().catch((error) => setStatus(`Connect error: ${error.message}`));
  });

  openTargetBtn.addEventListener('click', () => {
    openTarget(targetUrlInput.value).catch((error) => setStatus(`Open target error: ${error.message}`));
  });

  openTargetTabBtn.addEventListener('click', () => {
    try {
      openTargetInNewTab(targetUrlInput.value);
    } catch (error) {
      setStatus(`Open target tab error: ${error.message}`);
    }
  });

  shareBtn.addEventListener('click', () => {
    console.log('[daemon-agent] Share button clicked');
    shareScreen().catch((error) => setStatus(`Share error: ${error.message}`));
  });

  document.getElementById('disconnect').addEventListener('click', () => {
    disconnect().catch((error) => setStatus(`Disconnect error: ${error.message}`));
  });
})();
