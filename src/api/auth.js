/**
 * Returns { status, body } to reject the request, or null to allow it.
 * Only active when a non-empty token string is passed. When token is falsy,
 * always returns null so the bridge behaves exactly as before.
 */
export function checkToken(req, token) {
  if (!token) return null;

  const auth = req.headers['authorization'] ?? '';
  const spaceIdx = auth.indexOf(' ');
  const scheme = spaceIdx === -1 ? auth : auth.slice(0, spaceIdx);
  const provided = spaceIdx === -1 ? '' : auth.slice(spaceIdx + 1);

  if (scheme === 'Bearer' && provided === token) return null;

  return {
    status: 401,
    body: { ok: false, error: 'invalid or missing bearer token' },
  };
}
