function asTrimmedString(value) {
  return String(value ?? '').trim();
}

export function parseRtcIceServersJson(value) {
  const text = asTrimmedString(value);
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.iceServers)) {
      return parsed.iceServers;
    }
  } catch {
    return [];
  }

  return [];
}

export function normalizeIceUrlList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeIceUrlList(entry))
      .filter(Boolean);
  }

  const text = asTrimmedString(value);
  if (!text) {
    return [];
  }

  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIceServerEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const urls = normalizeIceUrlList(entry.urls);
  if (!urls.length) {
    return null;
  }

  const normalized = {
    urls: urls.length === 1 ? urls[0] : urls,
  };

  const username = asTrimmedString(entry.username);
  const credential = asTrimmedString(entry.credential);

  if (username) {
    normalized.username = username;
  }
  if (credential) {
    normalized.credential = credential;
  }

  return normalized;
}

function buildIceServersFromFields(input) {
  const stunUrls = normalizeIceUrlList(input?.stunUrls ?? input?.stunServers ?? input?.stunServer);
  const turnUrls = normalizeIceUrlList(input?.turnUrls ?? input?.turnServers ?? input?.turnServer);
  const turnUsername = asTrimmedString(input?.turnUsername ?? input?.turnUser);
  const turnCredential = asTrimmedString(input?.turnCredential ?? input?.turnPassword);
  const iceServers = [];

  if (stunUrls.length) {
    iceServers.push({
      urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls,
    });
  }

  if (turnUrls.length) {
    const turnServer = {
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
    };

    if (turnUsername) {
      turnServer.username = turnUsername;
    }
    if (turnCredential) {
      turnServer.credential = turnCredential;
    }

    iceServers.push(turnServer);
  }

  return iceServers;
}

function deriveIceFields(iceServers) {
  const stunUrls = [];
  const turnUrls = [];
  let turnUsername = '';
  let turnCredential = '';

  for (const server of iceServers) {
    const normalized = normalizeIceServerEntry(server);
    if (!normalized) {
      continue;
    }

    const urls = normalizeIceUrlList(normalized.urls);
    const stunEntries = urls.filter((url) => /^stuns?:/i.test(url));
    const turnEntries = urls.filter((url) => /^turns?:/i.test(url));

    stunUrls.push(...stunEntries);
    turnUrls.push(...turnEntries);

    if (!turnUsername && turnEntries.length) {
      turnUsername = asTrimmedString(normalized.username);
    }
    if (!turnCredential && turnEntries.length) {
      turnCredential = asTrimmedString(normalized.credential);
    }
  }

  return {
    stunUrls,
    turnUrls,
    turnUsername,
    turnCredential,
  };
}

export function normalizeRtcIceOptions(input = {}) {
  const directIceServers = Array.isArray(input?.rtcIceServers)
    ? input.rtcIceServers
    : Array.isArray(input?.rtcConfiguration?.iceServers)
      ? input.rtcConfiguration.iceServers
      : null;

  const normalizedIceServers = (directIceServers?.length
    ? directIceServers
    : buildIceServersFromFields(input)
  )
    .map((entry) => normalizeIceServerEntry(entry))
    .filter(Boolean);

  const derived = deriveIceFields(normalizedIceServers);
  const explicitTurnUsername = asTrimmedString(input?.turnUsername ?? input?.turnUser);
  const explicitTurnCredential = asTrimmedString(input?.turnCredential ?? input?.turnPassword);

  return {
    stunUrls: derived.stunUrls,
    turnUrls: derived.turnUrls,
    turnUsername: explicitTurnUsername || derived.turnUsername,
    turnCredential: explicitTurnCredential || derived.turnCredential,
    rtcIceServers: normalizedIceServers,
    rtcConfiguration: normalizedIceServers.length ? { iceServers: normalizedIceServers } : {},
  };
}

export function formatIceUrls(value) {
  return normalizeIceUrlList(value).join('\n');
}