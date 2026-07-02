function getMouseButtonsMask(buttonCode) {
  if (buttonCode === 2) {
    return 2;
  }
  if (buttonCode === 1) {
    return 4;
  }
  return 1;
}

function getMouseButtonCode(button = 'left') {
  if (button === 'right') {
    return 2;
  }
  if (button === 'middle') {
    return 1;
  }
  return 0;
}

export function mapRemoteCoordinates(payload = {}, { sourceWidth = 1, sourceHeight = 1, targetWidth = 1, targetHeight = 1 } = {}) {
  const resolvedSourceWidth = Number(payload.sourceWidth || sourceWidth || 1);
  const resolvedSourceHeight = Number(payload.sourceHeight || sourceHeight || 1);
  const resolvedTargetWidth = Math.max(1, Number(targetWidth || 1));
  const resolvedTargetHeight = Math.max(1, Number(targetHeight || 1));
  const x = Number(payload.x || 0);
  const y = Number(payload.y || 0);

  const mappedX = Math.max(0, Math.min(resolvedTargetWidth - 1, Math.round((x / resolvedSourceWidth) * resolvedTargetWidth)));
  const mappedY = Math.max(0, Math.min(resolvedTargetHeight - 1, Math.round((y / resolvedSourceHeight) * resolvedTargetHeight)));

  return {
    x: mappedX,
    y: mappedY,
    targetWidth: resolvedTargetWidth,
    targetHeight: resolvedTargetHeight,
  };
}

export function canAccessWindowDom(targetWindow) {
  if (!targetWindow || targetWindow.closed) {
    return false;
  }

  try {
    void targetWindow.document;
    return true;
  } catch {
    return false;
  }
}

export function createTargetTabCommandForwarder({
  getTargetWindow,
  getFallbackViewport,
  waitForExtensionAck,
  createRequestId,
  normalizeTargetUrl,
  getTargetUrl,
  logger = console,
}) {
  return async function forwardCommandToTargetTab(command) {
    const targetWindow = getTargetWindow();
    const { type, payload = {} } = command;
    const requestId = command.requestId || createRequestId('cmd-local');
    const commandForSend = command.requestId ? command : { ...command, requestId };

    logger.debug('[daemon-agent] forwardCommandToTargetTab start', {
      type,
      payload,
      hasTargetTab: Boolean(targetWindow && !targetWindow.closed),
    });

    if (!targetWindow || targetWindow.closed) {
      logger.debug('[daemon-agent] forwardCommandToTargetTab aborted: target tab missing/closed', { type });
      return { ok: false, error: 'Target tab is not open. Use Open In New Tab first.' };
    }

    try {
      logger.log('[daemon-agent] forwardCommandToTargetTab postMessage', { type, payload, requestId });
      targetWindow.postMessage({ type: 'agentic-input', command: commandForSend, ts: Date.now() }, '*');

      if (type === 'mouse_move') {
        return { ok: true, message: 'mouse_move forwarded to target tab.' };
      }

      const ackPreferredTypes = new Set(['extension_ping', 'open_url', 'close_page', 'text_input', 'key_press', 'mouse_down', 'mouse_up', 'mouse_click']);
      if (ackPreferredTypes.has(type)) {
        const extensionAck = await waitForExtensionAck(requestId, 1100);
        if (extensionAck) {
          logger.log('[daemon-agent] forwardCommandToTargetTab extension ack', {
            requestId,
            type,
            ack: extensionAck,
          });
          return {
            ok: extensionAck.ok !== false,
            message: extensionAck.message || `${type} applied by extension bridge.`,
            bridge: 'extension',
          };
        }

        logger.log('[daemon-agent] forwardCommandToTargetTab extension ack timeout, falling back', {
          requestId,
          type,
          canAccessTargetDom: canAccessWindowDom(targetWindow),
        });
      }

      if (!canAccessWindowDom(targetWindow)) {
        return {
          ok: false,
          error: 'Extension ack not received for cross-origin target tab. Refresh the target page after installing the extension, then click Check Extension again.',
        };
      }

      const targetDoc = targetWindow.document;
      targetDoc.dispatchEvent(
        new targetWindow.CustomEvent('agentic-input', {
          detail: { command: commandForSend, ts: Date.now() },
        })
      );

      if (type === 'open_url') {
        const url = normalizeTargetUrl(payload.url || getTargetUrl());
        logger.debug('[daemon-agent] forwardCommandToTargetTab open_url', { url });
        targetWindow.location.href = url;
        return { ok: true, message: `open_url sent to target tab: ${url}` };
      }

      if (type === 'close_page') {
        logger.debug('[daemon-agent] forwardCommandToTargetTab close_page');
        targetWindow.close();
        return { ok: true, message: 'Target tab closed.' };
      }

      if (type === 'text_input') {
        const text = String(payload.text || '');
        logger.debug('[daemon-agent] forwardCommandToTargetTab text_input', { text, textLength: text.length });

        let editableElement = targetDoc.activeElement;
        if (!editableElement || editableElement === targetDoc.body) {
          editableElement = targetDoc.querySelector('input, textarea, [contenteditable="true"]');
        }
        if (!editableElement) {
          logger.debug('[daemon-agent] forwardCommandToTargetTab text_input: no editable element found');
          return { ok: true, message: 'text_input message sent to target tab via postMessage/custom event.' };
        }

        if (typeof editableElement.focus === 'function') {
          editableElement.focus();
        }

        if (typeof editableElement.value === 'string') {
          editableElement.value += text;
          logger.debug('[daemon-agent] forwardCommandToTargetTab text_input applied to value field', {
            tagName: editableElement.tagName,
            id: editableElement.id,
            valueLength: editableElement.value.length,
          });
          editableElement.dispatchEvent(
            new targetWindow.InputEvent('input', {
              bubbles: true,
              data: text,
              inputType: 'insertText',
            })
          );
          return { ok: true, message: `text_input replayed in target tab (${text.length} chars).` };
        }

        if (editableElement.isContentEditable) {
          editableElement.textContent = `${editableElement.textContent || ''}${text}`;
          logger.debug('[daemon-agent] forwardCommandToTargetTab text_input applied to contenteditable', {
            tagName: editableElement.tagName,
            id: editableElement.id,
            textLength: editableElement.textContent.length,
          });
          editableElement.dispatchEvent(
            new targetWindow.InputEvent('input', {
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
        logger.debug('[daemon-agent] forwardCommandToTargetTab key_press', { key });

        const arrowKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

        let editableElement = targetDoc.activeElement;
        if (!editableElement || editableElement === targetDoc.body) {
          editableElement = targetDoc.querySelector('input, textarea, [contenteditable="true"]');
        }

        if (!editableElement) {
          return { ok: false, error: 'No editable element found for key_press in target tab.' };
        }

        if (typeof editableElement.focus === 'function') {
          editableElement.focus();
        }

        if (key === 'Backspace') {
          if (typeof editableElement.value === 'string') {
            const start = editableElement.selectionStart;
            const end = editableElement.selectionEnd;
            if (start != null && end != null) {
              if (start !== end) {
                editableElement.setRangeText('', start, end, 'end');
              } else if (start > 0) {
                editableElement.setRangeText('', start - 1, start, 'end');
              }
            } else if (editableElement.value.length > 0) {
              editableElement.value = editableElement.value.slice(0, -1);
            }

            editableElement.dispatchEvent(
              new targetWindow.InputEvent('input', {
                bubbles: true,
                data: null,
                inputType: 'deleteContentBackward',
              })
            );
            return { ok: true, message: 'Backspace replayed in target tab input.' };
          }

          if (editableElement.isContentEditable) {
            targetDoc.execCommand('delete');
            return { ok: true, message: 'Backspace replayed in target tab contenteditable.' };
          }
        }

        if (arrowKeys.has(key)) {
          if (typeof editableElement.value === 'string') {
            const start = editableElement.selectionStart;
            const end = editableElement.selectionEnd;
            if (start != null && end != null) {
              let nextPos = start;

              if (key === 'ArrowLeft') {
                nextPos = start !== end ? start : Math.max(0, start - 1);
              } else if (key === 'ArrowRight') {
                nextPos = start !== end ? end : Math.min(editableElement.value.length, end + 1);
              } else if (key === 'ArrowUp') {
                if (editableElement.tagName === 'TEXTAREA') {
                  const lineStart = editableElement.value.lastIndexOf('\n', start - 1) + 1;
                  const col = start - lineStart;
                  if (lineStart > 0) {
                    const prevLineEnd = lineStart - 1;
                    const prevLineStart = editableElement.value.lastIndexOf('\n', prevLineEnd - 1) + 1;
                    const prevLineLen = prevLineEnd - prevLineStart;
                    nextPos = prevLineStart + Math.min(col, prevLineLen);
                  } else {
                    nextPos = 0;
                  }
                } else {
                  nextPos = 0;
                }
              } else if (key === 'ArrowDown') {
                if (editableElement.tagName === 'TEXTAREA') {
                  const lineStart = editableElement.value.lastIndexOf('\n', start - 1) + 1;
                  const col = start - lineStart;
                  const lineEnd = editableElement.value.indexOf('\n', start);
                  if (lineEnd >= 0) {
                    const nextLineStart = lineEnd + 1;
                    const nextLineEndIndex = editableElement.value.indexOf('\n', nextLineStart);
                    const nextLineEnd = nextLineEndIndex >= 0 ? nextLineEndIndex : editableElement.value.length;
                    const nextLineLen = nextLineEnd - nextLineStart;
                    nextPos = nextLineStart + Math.min(col, nextLineLen);
                  } else {
                    nextPos = editableElement.value.length;
                  }
                } else {
                  nextPos = editableElement.value.length;
                }
              }

              editableElement.setSelectionRange(nextPos, nextPos, 'none');
              return { ok: true, message: `${key} replayed in target tab input.` };
            }
          }

          if (editableElement.isContentEditable) {
            const selection = targetWindow.getSelection();
            const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? 'backward' : 'forward';
            selection.modify('move', direction, key === 'ArrowLeft' || key === 'ArrowRight' ? 'character' : 'line');
            return { ok: true, message: `${key} replayed in target tab contenteditable.` };
          }
        }

        editableElement.dispatchEvent(
          new targetWindow.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            view: targetWindow,
          })
        );
        editableElement.dispatchEvent(
          new targetWindow.KeyboardEvent('keyup', {
            key,
            bubbles: true,
            cancelable: true,
            view: targetWindow,
          })
        );
        return { ok: true, message: `key_press replayed in target tab (${key || 'unknown'}).` };
      }

      if (type === 'mouse_move' || type === 'mouse_down' || type === 'mouse_up' || type === 'mouse_click') {
        const fallbackViewport = getFallbackViewport();
        const mapped = mapRemoteCoordinates(payload, {
          sourceWidth: fallbackViewport.width,
          sourceHeight: fallbackViewport.height,
          targetWidth: targetWindow.innerWidth || fallbackViewport.width || 1,
          targetHeight: targetWindow.innerHeight || fallbackViewport.height || 1,
        });
        logger.debug('[daemon-agent] forwardCommandToTargetTab mouse coords mapped', {
          type,
          payload,
          mapped,
        });

        const targetElement = targetDoc.elementFromPoint(mapped.x, mapped.y);
        if (!targetElement) {
          logger.debug('[daemon-agent] forwardCommandToTargetTab mouse: no element at point', mapped);
          return { ok: true, message: `${type} message sent to target tab via postMessage/custom event.` };
        }

        if (typeof targetElement.focus === 'function') {
          targetElement.focus();
        }

        const button = payload.button || 'left';
        const buttonCode = getMouseButtonCode(button);
        const buttonsMask = getMouseButtonsMask(buttonCode);

        targetElement.dispatchEvent(
          new targetWindow.MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: mapped.x,
            clientY: mapped.y,
            button: buttonCode,
            buttons: type === 'mouse_up' ? 0 : payload.isDragging || type === 'mouse_down' || type === 'mouse_click' ? buttonsMask : 0,
            view: targetWindow,
          })
        );
        logger.debug('[daemon-agent] forwardCommandToTargetTab mouse_move dispatched', {
          tagName: targetElement.tagName,
          id: targetElement.id,
          x: mapped.x,
          y: mapped.y,
        });

        if (type === 'mouse_down') {
          targetElement.dispatchEvent(
            new targetWindow.MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              buttons: buttonsMask,
              view: targetWindow,
            })
          );
          return { ok: true, message: `mouse_down replayed in target tab at (${mapped.x}, ${mapped.y}).` };
        }

        if (type === 'mouse_up') {
          targetElement.dispatchEvent(
            new targetWindow.MouseEvent('mouseup', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              buttons: 0,
              view: targetWindow,
            })
          );
          return { ok: true, message: `mouse_up replayed in target tab at (${mapped.x}, ${mapped.y}).` };
        }

        if (type === 'mouse_click') {
          targetElement.dispatchEvent(
            new targetWindow.MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              buttons: buttonsMask,
              view: targetWindow,
            })
          );
          targetElement.dispatchEvent(
            new targetWindow.MouseEvent('mouseup', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              buttons: 0,
              view: targetWindow,
            })
          );
          targetElement.dispatchEvent(
            new targetWindow.MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              clientX: mapped.x,
              clientY: mapped.y,
              button: buttonCode,
              buttons: 0,
              view: targetWindow,
            })
          );
          logger.debug('[daemon-agent] forwardCommandToTargetTab mouse_click dispatched', {
            tagName: targetElement.tagName,
            id: targetElement.id,
            x: mapped.x,
            y: mapped.y,
            button,
          });
        }

        return { ok: true, message: `${type} replayed in target tab at (${mapped.x}, ${mapped.y}).` };
      }

      return { ok: true, message: `${type} sent to target tab via postMessage/custom event.` };
    } catch (error) {
      logger.debug('[daemon-agent] forwardCommandToTargetTab fallback only', { type, error: error.message });
      return {
        ok: true,
        message: `${type} sent to target tab via postMessage fallback only (${error.message}).`,
      };
    }
  };
}
