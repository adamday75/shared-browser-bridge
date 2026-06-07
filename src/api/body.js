// All page action bodies are small JSON objects (a URL, a selector, a string
// to type) — 1 MB is generously larger than any legitimate request and small
// enough to rule out a hostile/malformed caller streaming an unbounded body
// into memory.
const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    this.name = 'BodyTooLargeError';
    this.status = 413;
  }
}

/**
 * Reads and parses a JSON request body. Resolves to `null` for an empty body
 * so callers can decide whether that's acceptable for their route. Rejects
 * with `BodyTooLargeError` (status 413) once the body exceeds MAX_BODY_BYTES,
 * then ignores the rest of the stream so the route can still return an honest
 * JSON 413 response instead of aborting the whole connection.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let tooLarge = false;
    let settled = false;

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    req.on('data', (chunk) => {
      if (tooLarge || settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        rejectOnce(new BodyTooLargeError());
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge || settled) return;
      if (!data) {
        resolveOnce(null);
        return;
      }
      try {
        resolveOnce(JSON.parse(data));
      } catch {
        rejectOnce(new Error('request body must be valid JSON'));
      }
    });
    req.on('error', (err) => {
      if (!tooLarge) rejectOnce(err);
    });
  });
}
