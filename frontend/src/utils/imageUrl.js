/**
 * Add the query-token required by authenticated <img> requests while keeping
 * any existing space qualifier intact.
 */
export function withImageAuthToken(url, token, {
  origin = globalThis.location?.origin || 'http://localhost',
  absolute = true,
} = {}) {
  if (!token) return url;
  const parsed = new URL(url, origin);
  parsed.searchParams.set('token', token);
  return absolute ? parsed.href : `${parsed.pathname}${parsed.search}`;
}
