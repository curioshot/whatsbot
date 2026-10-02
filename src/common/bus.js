// Typed event bus for the service worker router.
// Handlers register by message type; dispatch() routes and normalizes the
// envelope. New features register here instead of extending a god-switch.
export class WbError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const handlers = new Map();

export function on(type, fn) {
  if (typeof type !== 'string' || !type) throw new WbError('BAD_HANDLER', 'handler type must be a non-empty string');
  if (typeof fn !== 'function') throw new WbError('BAD_HANDLER', `handler for ${type} must be a function`);
  if (handlers.has(type)) throw new WbError('DUPLICATE_HANDLER', `duplicate handler for ${type}`);
  handlers.set(type, fn);
  return fn;
}

export function off(type) {
  handlers.delete(type);
}

export function clearBus() {
  handlers.clear();
}

export function has(type) {
  return handlers.has(type);
}

export function types() {
  return [...handlers.keys()];
}

// Resolves with the handler's payload (without `ok`). Rejects with WbError
// (carrying .code) or plain Errors. Callers add the {ok} envelope.
export async function dispatch(msg, sender) {
  const t = msg?.type;
  if (typeof t !== 'string' || !t) throw new WbError('UNKNOWN_TYPE', `unknown type: ${String(t)}`);
  const fn = handlers.get(t);
  if (!fn) throw new WbError('UNKNOWN_TYPE', `unknown type: ${t}`);
  return fn(msg, sender);
}
