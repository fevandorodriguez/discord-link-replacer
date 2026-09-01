// Recent activity for the admin panel. Deliberately holds only a timestamp, a
// level and a line of text: the panel sits behind one shared password, so a
// buffer that could carry message content would be a far larger thing to leak
// than the mode toggle it exists to serve.

// Sanitize a log value: only strings, numbers, and booleans pass through; everything
// else is replaced with a fixed placeholder. String() coercion is not safe because it
// calls custom toString() methods and Array.prototype.toString joins elements, both
// of which could leak content. Only values whose string form IS their own value are
// allowed; an attacker-influenced value cannot hide its contents in a placeholder.
function sanitizeLogValue(value) {
  const type = typeof value;
  if (type === 'string') return value;
  if (type === 'number' || type === 'boolean') return String(value);
  return '[non-string log value]';
}

export function createLogBuffer(size = 200) {
  // Validate size: must be a positive integer. Unbounded buffers in long-running
  // processes cause memory leaks; nonsense values fall back to default.
  if (!Number.isInteger(size) || size <= 0) {
    size = 200;
  }

  const entries = [];

  function record(level, text) {
    // Sanitize text: only strings, numbers, and booleans reach the buffer.
    // Everything else is replaced with a fixed placeholder, preventing custom
    // toString, array joins, and other coercion paths from leaking content.
    entries.push({ at: new Date().toISOString(), level, text: sanitizeLogValue(text) });
    if (entries.length > size) entries.shift();
  }

  return {
    record,
    // Deep copy: entries.slice() copies the array but not its contents. Returning
    // { ...e } for each entry ensures the panel cannot mutate the buffer via
    // returned references.
    entries: () => entries.map((e) => ({ ...e })),
    // Wraps the real logger so stdout keeps exactly the output it has today
    // and the buffer is purely additive. Rest arguments preserve full fidelity
    // to the base logger while recording only the first argument (guaranteeing
    // no structured data reaches the buffer).
    attach(base) {
      return {
        info: (...args) => { base.info(...args); record('info', args[0]); },
        warn: (...args) => { base.warn(...args); record('warn', args[0]); },
        error: (...args) => { base.error(...args); record('error', args[0]); },
      };
    },
  };
}
