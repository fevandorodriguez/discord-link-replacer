// Recent activity for the admin panel. Deliberately holds only a timestamp, a
// level and a line of text: the panel sits behind one shared password, so a
// buffer that could carry message content would be a far larger thing to leak
// than the mode toggle it exists to serve.
export function createLogBuffer(size = 200) {
  const entries = [];

  function record(level, text) {
    entries.push({ at: new Date().toISOString(), level, text });
    if (entries.length > size) entries.shift();
  }

  return {
    record,
    // A copy: the panel reads this on every poll and must not be able to
    // mutate the buffer by accident.
    entries: () => entries.slice(),
    // Wraps the real logger so stdout keeps exactly the output it has today
    // and the buffer is purely additive.
    attach(base) {
      return {
        info: (text) => { base.info(text); record('info', text); },
        warn: (text) => { base.warn(text); record('warn', text); },
        error: (text) => { base.error(text); record('error', text); },
      };
    },
  };
}
