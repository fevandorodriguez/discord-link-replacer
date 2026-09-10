import { readFileSync } from 'node:fs';
import { PLATFORMS, DEFAULT_DOMAINS } from './rules.js';

export const MODES = ['repost', 'suppress'];
const DEFAULT_MODE = 'repost';

export const MAX_QUIP_LENGTH = 2000;
export const MAX_QUIPS = 50;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// The five rules an announce settings object must satisfy, shared by the
// config loader (Boot time, from config.json) and the admin panel's store
// (write time, from a request body). One copy so the two can never drift:
// if the store's rules ever went looser than the loader's, a panel save
// would write a config that the next restart's loadConfig rejects -- the
// panel would brick the bot's boot, and the only symptom is a container
// that will not come up.
//
// Strict and un-defaulting: undefined is not valid input here, only a
// resolved `{ channelId, quips }`. Returns null when valid, or a problem
// string naming the offending field and value.
export function validateAnnounce({ channelId, quips }) {
  // Digits only: the panel always supplies a real id from its dropdown, so
  // there is no channel name to resolve and nothing to guess at.
  if (typeof channelId !== 'string' || (channelId !== '' && !/^\d+$/.test(channelId))) {
    return `Invalid "announce.channelId": expected a channel id of digits, or "" for none, got ${JSON.stringify(channelId)}.`;
  }

  if (!Array.isArray(quips)) {
    return `Invalid "announce.quips": expected an array of strings, got ${JSON.stringify(quips)}.`;
  }
  if (quips.length > MAX_QUIPS) {
    return `Too many entries in "announce.quips": at most ${MAX_QUIPS}, got ${quips.length}.`;
  }
  for (const quip of quips) {
    if (typeof quip !== 'string' || quip.trim().length === 0) {
      return `Invalid entry in "announce.quips": expected a non-empty string, got ${JSON.stringify(quip)}.`;
    }
    // Report the length, never the quip itself -- a 2001-character error
    // message is unreadable, and the content adds nothing the length doesn't.
    if (quip.length > MAX_QUIP_LENGTH) {
      return `An entry in "announce.quips" is longer than ${MAX_QUIP_LENGTH} characters (${quip.length}), which Discord will not accept.`;
    }
  }

  return null;
}

// The restart quips and the channel they go to. Free text set through a
// password-gated web page, so every rule here is enforced at startup rather
// than trusted: a malformed value is fatal, exactly like a bad domain.
function resolveAnnounce(raw, file) {
  if (raw === undefined) return { channelId: '', quips: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid "announce" in ${file}: expected an object, got ${JSON.stringify(raw)}.`);
  }

  const channelId = raw.channelId !== undefined ? raw.channelId : '';
  const quips = raw.quips !== undefined ? raw.quips : [];

  const problem = validateAnnounce({ channelId, quips });
  if (problem) {
    throw new Error(`${problem} (in ${file})`);
  }

  return { channelId, quips };
}

export function loadConfig({ file = 'config.json', env = process.env } = {}) {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set; the bot cannot log in.');

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read config from ${file}: ${error.message}`);
  }

  // A JSON scalar, null or array parses fine but is not a config: null threw a
  // bare "Cannot convert undefined or null to object" from Object.keys below,
  // and an array was silently accepted as an all-defaults config.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Config in ${file} must be a JSON object mapping platform names to settings.`);
  }

  for (const key of Object.keys(raw)) {
    if (key === 'mode' || key === 'announce') continue;
    if (!PLATFORMS.includes(key)) {
      throw new Error(`Unknown platform "${key}" in ${file}. Known platforms: ${PLATFORMS.join(', ')}.`);
    }
  }

  const platforms = {};
  for (const platform of PLATFORMS) {
    const entry = raw[platform] ?? {};
    const domain = envDomain(env, platform) ?? entry.domain ?? DEFAULT_DOMAINS[platform];
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid domain "${domain}" for ${platform} in ${file}; expected a bare hostname such as ${DEFAULT_DOMAINS[platform]}.`);
    }
    // "enabled": "false" is a truthy string, so a platform an operator meant to
    // switch off stayed on. Malformed values are fatal here, like unknown keys
    // and malformed domains, rather than silently inverting their intent.
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`Invalid "enabled" for ${platform} in ${file}: expected true or false, got ${JSON.stringify(entry.enabled)}.`);
    }
    // An optional real post path for the mirror health check to fetch. The root
    // alone cannot see a mirror that is blocked at the API rather than dead —
    // rxddit served its front page normally while returning a block notice for
    // every actual link. Validated here so a typo is a startup error rather
    // than a health check that quietly probes the wrong URL forever.
    if (entry.canary !== undefined && (typeof entry.canary !== 'string' || !entry.canary.startsWith('/'))) {
      throw new Error(`Invalid "canary" for ${platform} in ${file}: expected a path beginning with "/", got ${JSON.stringify(entry.canary)}.`);
    }
    const enabled = envEnabled(env, platform) ?? entry.enabled ?? true;
    platforms[platform] = { enabled, domain, ...(entry.canary ? { canary: entry.canary } : {}) };
  }

  const { mode, modeSource } = resolveMode(raw.mode, env, file);
  const announce = resolveAnnounce(raw.announce, file);

  return { token, mode, modeSource, platforms, announce };
}

function envDomain(env, platform) {
  return env[`LINKFIX_${platform.toUpperCase()}_DOMAIN`] || undefined;
}

// Only "true" and "false" (any case) are accepted. Testing `=== 'true'` alone
// turned LINKFIX_X_ENABLED=yes / 1 / on into a silent disable.
function envEnabled(env, platform) {
  const name = `LINKFIX_${platform.toUpperCase()}_ENABLED`;
  const value = env[name];
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  throw new Error(`Invalid ${name}: expected "true" or "false", got "${value}".`);
}

// The delivery mode: repost (delete and repost) or suppress (leave and reply).
// Env var beats file beats default. Case-folding is silent, but whitespace is not:
// a stray space fails loudly rather than being silently stripped.
// Returns modeSource alongside mode so callers (the ready-log line) can tell an
// operator *where* the active mode came from — the env var always wins over
// config.json, silently, so that's the one fact worth surfacing at boot.
function resolveMode(fromFile, env, file) {
  if (env.LINKFIX_MODE !== undefined) {
    const mode = String(env.LINKFIX_MODE).toLowerCase();
    if (!MODES.includes(mode)) {
      throw new Error(`Invalid LINKFIX_MODE: expected one of ${MODES.join(', ')}, got "${env.LINKFIX_MODE}".`);
    }
    return { mode, modeSource: 'LINKFIX_MODE' };
  }
  if (fromFile !== undefined) {
    const mode = String(fromFile).toLowerCase();
    if (!MODES.includes(mode)) {
      throw new Error(`Invalid mode "${fromFile}" in ${file}; expected one of ${MODES.join(', ')}.`);
    }
    return { mode, modeSource: 'config.json' };
  }
  return { mode: DEFAULT_MODE, modeSource: 'default' };
}
