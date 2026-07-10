export async function loadClientRuntimeConfig(runtimePath = '/client-demo.runtime.json') {
  try {
    const response = await fetch(runtimePath, { cache: 'no-store' });
    if (!response.ok) {
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

export function summarizeIceConfigForLog(rtcOptions) {
  const iceServers = Array.isArray(rtcOptions?.rtcIceServers) ? rtcOptions.rtcIceServers : [];
  const stunUrls = iceServers
    .flatMap((entry) => (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]))
    .filter((url) => /^stuns?:/i.test(String(url || '').trim()));
  const turnUrls = iceServers
    .flatMap((entry) => (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls]))
    .filter((url) => /^turns?:/i.test(String(url || '').trim()));
  const firstTurnServer = iceServers.find((entry) => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    return urls.some((url) => /^turns?:/i.test(String(url || '').trim()));
  });

  return {
    stunUrls,
    turnUrls,
    turnUsername: firstTurnServer?.username || '',
    hasTurnCredential: Boolean(firstTurnServer?.credential),
    iceServerCount: iceServers.length,
  };
}

export function readSearchParam(searchParams, name, fallback = '') {
  const value = searchParams.get(name);
  return value && String(value).trim() ? String(value).trim() : fallback;
}

export function readSearchParamAny(searchParams, names, fallback = '') {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
}

export function readSearchPercentParam(searchParams, names, fallback = 100) {
  for (const name of names) {
    const raw = searchParams.get(name);
    if (!raw) {
      continue;
    }

    const parsed = Number.parseFloat(String(raw).replace('%', ''));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

export function hasAnySearchParam(searchParams, names) {
  return names.some((name) => {
    const value = searchParams.get(name);
    return value && String(value).trim();
  });
}
