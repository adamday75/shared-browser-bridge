import { BodyTooLargeError } from './body.js';

export function badRequest(message) {
  return { status: 400, body: { ok: false, code: 'INVALID_INPUT', error: message } };
}

export function tooLarge(message) {
  return { status: 413, body: { ok: false, code: 'BODY_TOO_LARGE', error: message } };
}

export function bodyErrorResponse(error) {
  return error instanceof BodyTooLargeError ? tooLarge(error.message) : badRequest(error.message);
}
