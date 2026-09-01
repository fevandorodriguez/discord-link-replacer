import { readFileSync } from 'node:fs';
import { PLATFORMS, DEFAULT_DOMAINS } from './rules.js';

export const MODES = ['repost', 'suppress'];
const DEFAULT_MODE = 'repost';

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

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
    if (key === 'mode') continue;
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
    const enabled = envEnabled(env, platform) ?? entry.enabled ?? true;
    platforms[platform] = { enabled, domain };
  }

  const mode = resolveMode(raw.mode, env, file);

  return { token, mode, platforms };
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
function resolveMode(fromFile, env, file) {
  if (env.LINKFIX_MODE !== undefined) {
    const mode = String(env.LINKFIX_MODE).toLowerCase();
    if (!MODES.includes(mode)) {
      throw new Error(`Invalid LINKFIX_MODE: expected one of ${MODES.join(', ')}, got "${env.LINKFIX_MODE}".`);
    }
    return mode;
  }
  if (fromFile !== undefined) {
    const mode = String(fromFile).toLowerCase();
    if (!MODES.includes(mode)) {
      throw new Error(`Invalid mode "${fromFile}" in ${file}; expected one of ${MODES.join(', ')}.`);
    }
    return mode;
  }
  return DEFAULT_MODE;
}
