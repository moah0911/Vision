/**
 * Shared configuration accessors.
 *
 * The server URL was previously re-derived with `as any` in five places across the background
 * worker and the popup, which let a malformed stored value reach `fetch` and throw.
 */

export const DEFAULT_SERVER_URL = 'http://localhost:8000';

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Normalised base URL with no trailing slash, falling back to the default when unusable. */
export function normaliseServerUrl(value: unknown): string {
  if (!isHttpUrl(value)) return DEFAULT_SERVER_URL;
  return value.trim().replace(/\/+$/, '');
}

/** Read the configured server URL from extension storage. */
export async function resolveServerUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get('serverUrl');
    return normaliseServerUrl(stored?.serverUrl);
  } catch {
    return DEFAULT_SERVER_URL;
  }
}
