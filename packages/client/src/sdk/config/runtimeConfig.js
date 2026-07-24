// Fetch the client runtime config the server exposes at /client.runtime.json
// (generated from .env). Returns {} on any failure so the caller can fall back
// to its own defaults.
export async function loadClientRuntimeConfig(runtimePath = '/client.runtime.json') {
  try {
    const response = await fetch(runtimePath, { cache: 'no-store' });
    if (!response.ok) {
      console.warn(`[client] Runtime config not found at ${runtimePath} (${response.status} ${response.statusText}). Using defaults.`);
      return {};
    }
    const config = await response.json();
    return config && typeof config === 'object' ? config : {};
  } catch (error) {
    console.warn(`[client] Failed to load runtime config from ${runtimePath}:`, error.message);
    return {};
  }
}
