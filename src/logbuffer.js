// Recent activity for the admin panel. Deliberately holds only a timestamp, a
// level and a line of text: the panel sits behind one shared password, so a
// buffer that could carry message content would be a far larger thing to leak
// than the mode toggle it exists to serve.
export function createLogBuffer(size = 200) {
  // Validate size: must be a positive integer. Unbounded buffers in long-running
  // processes cause memory leaks; nonsense values fall back to default.
  if (!Number.isInteger(size) || size <= 0) {
    size = 200;
  }

  const entries = [];

  function record(level, text) {
    // Coerce text to string to prevent structured data (objects with message
    // content or URLs) from being stored. String({...}) yields '[object Object]',
    // which leaks nothing. A log call that crashes the bot is worse than an
    // unhelpful line.
    entries.push({ at: new Date().toISOString(), level, text: String(text) });
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
