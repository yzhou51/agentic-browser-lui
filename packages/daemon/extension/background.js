const tabRecords = new Map();
let controlledTabId = null;
let lastActiveTargetTabId = null;

function isDaemonUrl(url = '') {
  return /\/daemon-agent\.html(?:[?#]|$)/i.test(String(url || ''));
}

function isControllableUrl(url = '') {
  return /^https?:/i.test(String(url || ''));
}

function updateTabRecord(tabId, info = {}) {
  const previous = tabRecords.get(tabId) || {};
  const next = {
    ...previous,
    ...info,
    tabId,
    lastSeenAt: Date.now(),
  };
  tabRecords.set(tabId, next);
  return next;
}

async function getTabDescriptor(tabId) {
  if (!tabId) {
    return null;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const record = updateTabRecord(tabId, {
      url: tab.url || '',
      title: tab.title || '',
      active: Boolean(tab.active),
      windowId: tab.windowId,
      status: tab.status || 'unknown',
    });

    if (!isControllableUrl(record.url) || isDaemonUrl(record.url)) {
      return null;
    }

    return {
      tabId,
      url: record.url,
      title: record.title,
      active: Boolean(record.active),
      status: record.status || 'unknown',
      lastSeenAt: record.lastSeenAt || null,
      lastActivatedAt: record.lastActivatedAt || null,
    };
  } catch {
    tabRecords.delete(tabId);
    if (controlledTabId === tabId) {
      controlledTabId = null;
    }
    if (lastActiveTargetTabId === tabId) {
      lastActiveTargetTabId = null;
    }
    return null;
  }
}

async function getLastActiveCandidateDescriptor() {
  const candidateIds = [...tabRecords.keys()]
    .map((tabId) => ({
      tabId,
      score: Math.max(tabRecords.get(tabId)?.lastActivatedAt || 0, tabRecords.get(tabId)?.lastSeenAt || 0),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.tabId);

  if (lastActiveTargetTabId && !candidateIds.includes(lastActiveTargetTabId)) {
    candidateIds.unshift(lastActiveTargetTabId);
  }

  for (const tabId of candidateIds) {
    const descriptor = await getTabDescriptor(tabId);
    if (descriptor) {
      return descriptor;
    }
  }

  return null;
}

async function getStatus() {
  const controlledTarget = await getTabDescriptor(controlledTabId);
  const lastActiveTarget = await getLastActiveCandidateDescriptor();

  return {
    ok: true,
    controlledTarget,
    lastActiveTarget,
  };
}

async function bindControlledTarget(tabId) {
  const descriptor = await getTabDescriptor(tabId);
  if (!descriptor) {
    return { ok: false, error: 'Selected tab is not controllable.' };
  }

  controlledTabId = descriptor.tabId;
  return {
    ok: true,
    controlledTarget: descriptor,
  };
}

async function bindLastActiveTarget() {
  const descriptor = await getLastActiveCandidateDescriptor();
  if (!descriptor) {
    return { ok: false, error: 'No recently active non-daemon tab is available.' };
  }
  controlledTabId = descriptor.tabId;
  return {
    ok: true,
    controlledTarget: descriptor,
  };
}

async function openTargetTab(url) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return { ok: false, error: 'Target URL is required.' };
  }

  try {
    const tab = await chrome.tabs.create({
      url: normalizedUrl,
      active: true,
    });

    if (!tab?.id) {
      return { ok: false, error: 'Chrome did not return a created tab id.' };
    }

    controlledTabId = tab.id;
    lastActiveTargetTabId = tab.id;

    updateTabRecord(tab.id, {
      url: tab.url || normalizedUrl,
      title: tab.title || '',
      active: Boolean(tab.active),
      status: tab.status || 'loading',
      windowId: tab.windowId,
      lastActivatedAt: Date.now(),
    });

    const descriptor = await getTabDescriptor(tab.id);
    return {
      ok: true,
      controlledTarget: descriptor,
      message: `Opened target tab: ${normalizedUrl}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to open target tab through extension.',
    };
  }
}

async function checkControlledTarget() {
  let descriptor = await getTabDescriptor(controlledTabId);
  if (!descriptor) {
    const bound = await bindLastActiveTarget();
    if (!bound.ok) {
      return bound;
    }
    descriptor = bound.controlledTarget;
  }

  try {
    const response = await chrome.tabs.sendMessage(descriptor.tabId, {
      type: 'agentic-run-command',
      command: {
        type: 'extension_ping',
        requestId: `sw-ping-${Date.now()}`,
        payload: {},
      },
    });

    return {
      ok: response?.result?.ok !== false,
      message: response?.result?.message || 'Extension bridge is active.',
      controlledTarget: descriptor,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to ping controlled target.',
      controlledTarget: descriptor,
    };
  }
}

async function activateControlledTarget() {
  let descriptor = await getTabDescriptor(controlledTabId);
  if (!descriptor) {
    const bound = await bindLastActiveTarget();
    if (!bound.ok) {
      return bound;
    }
    descriptor = bound.controlledTarget;
  }

  try {
    await chrome.tabs.update(descriptor.tabId, { active: true });
    if (typeof descriptor.windowId === 'number') {
      await chrome.windows.update(descriptor.windowId, { focused: true });
    }

    const refreshed = await getTabDescriptor(descriptor.tabId);
    return {
      ok: true,
      controlledTarget: refreshed || descriptor,
      message: 'Controlled tab activated.',
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to activate controlled target.',
      controlledTarget: descriptor,
    };
  }
}

async function dispatchCommand(command) {
  let descriptor = await getTabDescriptor(controlledTabId);
  if (!descriptor) {
    const bound = await bindLastActiveTarget();
    if (!bound.ok) {
      return bound;
    }
    descriptor = bound.controlledTarget;
  }

  const type = String(command?.type || '');
  const payload = command?.payload && typeof command.payload === 'object' ? command.payload : {};

  if (type === 'open_url') {
    const url = String(payload.url || '').trim();
    if (!url) {
      return { ok: false, error: 'open_url missing payload.url.', controlledTarget: descriptor };
    }
    await chrome.tabs.update(descriptor.tabId, { url });
    return { ok: true, message: `Navigating controlled tab to ${url}`, controlledTarget: descriptor, bridge: 'extension-service-worker' };
  }

  if (type === 'close_page') {
    await chrome.tabs.remove(descriptor.tabId);
    if (controlledTabId === descriptor.tabId) {
      controlledTabId = null;
    }
    return { ok: true, message: 'Controlled tab closed.', bridge: 'extension-service-worker' };
  }

  try {
    const response = await chrome.tabs.sendMessage(descriptor.tabId, {
      type: 'agentic-run-command',
      command,
    });

    return {
      ok: response?.result?.ok !== false,
      ...(response?.result || {}),
      controlledTarget: descriptor,
      bridge: 'extension-service-worker',
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to deliver command to controlled tab.',
      controlledTarget: descriptor,
      bridge: 'extension-service-worker',
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let responded = false;
  const respond = (payload) => {
    if (responded) {
      return;
    }
    responded = true;
    try {
      sendResponse(payload);
    } catch {
      // Sender may be gone (tab navigated/closed). Ignore in service worker.
    }
  };

  // Avoid leaving the channel open if any async path hangs.
  const responseTimeout = setTimeout(() => {
    respond({ ok: false, error: 'Extension background request timed out.' });
  }, 5000);

  (async () => {
    const type = String(message?.type || '');

    if (type === 'agentic-register-page') {
      const tabId = sender.tab?.id;
      if (!tabId) {
        respond({ ok: false, error: 'Missing sender tab.' });
        return;
      }

      const record = updateTabRecord(tabId, {
        url: sender.tab?.url || message?.payload?.href || '',
        title: sender.tab?.title || message?.payload?.title || '',
        active: Boolean(sender.tab?.active),
        status: sender.tab?.status || 'unknown',
        windowId: sender.tab?.windowId,
        lastActivatedAt: sender.tab?.active ? Date.now() : tabRecords.get(tabId)?.lastActivatedAt || 0,
      });

      if (!isDaemonUrl(record.url) && isControllableUrl(record.url)) {
        lastActiveTargetTabId = tabId;
      }

      respond({ ok: true });
      return;
    }

    if (type !== 'agentic-daemon-request') {
      respond({ ok: false, error: `Unsupported runtime message type: ${type}` });
      return;
    }

    const action = String(message?.action || '');

    if (action === 'get_status') {
      respond(await getStatus());
      return;
    }

    if (action === 'bind_last_active_target') {
      respond(await bindLastActiveTarget());
      return;
    }

    if (action === 'open_target_tab') {
      respond(await openTargetTab(message?.payload?.url || ''));
      return;
    }

    if (action === 'check_controlled_target') {
      respond(await checkControlledTarget());
      return;
    }

    if (action === 'activate_controlled_target') {
      respond(await activateControlledTarget());
      return;
    }

    if (action === 'dispatch_command') {
      respond(await dispatchCommand(message?.payload?.command || {}));
      return;
    }

    respond({ ok: false, error: `Unsupported daemon request action: ${action}` });
  })().catch((error) => {
    respond({ ok: false, error: error?.message || 'Extension background request failed.' });
  }).finally(() => {
    clearTimeout(responseTimeout);
  });

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isControllableUrl(tab.url || '') || isDaemonUrl(tab.url || '')) {
    return;
  }
  controlledTabId = tab.id;
  lastActiveTargetTabId = tab.id;
  updateTabRecord(tab.id, {
    url: tab.url || '',
    title: tab.title || '',
    active: Boolean(tab.active),
    status: tab.status || 'unknown',
    windowId: tab.windowId,
    lastActivatedAt: Date.now(),
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) {
    return;
  }

  const record = updateTabRecord(tab.id, {
    url: tab.url || '',
    title: tab.title || '',
    active: true,
    status: tab.status || 'unknown',
    windowId: tab.windowId,
    lastActivatedAt: Date.now(),
  });

  if (!isDaemonUrl(record.url) && isControllableUrl(record.url)) {
    lastActiveTargetTabId = tab.id;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const existing = tabRecords.get(tabId) || {};
  const record = updateTabRecord(tabId, {
    url: changeInfo.url || tab.url || existing.url || '',
    title: tab.title || existing.title || '',
    active: Boolean(tab.active),
    status: changeInfo.status || tab.status || existing.status || 'unknown',
    windowId: tab.windowId,
    lastActivatedAt: tab.active ? Date.now() : existing.lastActivatedAt || 0,
  });

  if (!isDaemonUrl(record.url) && isControllableUrl(record.url) && tab.active) {
    lastActiveTargetTabId = tabId;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabRecords.delete(tabId);
  if (controlledTabId === tabId) {
    controlledTabId = null;
  }
  if (lastActiveTargetTabId === tabId) {
    lastActiveTargetTabId = null;
  }
});
