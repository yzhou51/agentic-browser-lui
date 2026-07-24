// Small helpers for reading values out of a URLSearchParams instance, used to
// let the client demo pages accept overrides via query string.

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
