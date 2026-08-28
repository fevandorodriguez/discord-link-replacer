import { readFileSync } from 'node:fs';
import { PLATFORMS, DEFAULT_DOMAINS } from './rules.js';

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

  for (const key of Object.keys(raw)) {
    if (!PLATFORMS.includes(key)) {
      throw new Error(`Unknown platform "${key}" in ${file}. Known platforms: ${PLATFORMS.join(', ')}.`);
    }
  }

  const platforms = {};
  for (const platform of PLATFORMS) {
    const entry = raw[platform] ?? {};
    const domain = envDomain(env, platform) ?? entry.domain ?? DEFAULT_DOMAINS[platform];
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid domain "${domain}" for ${platform}; expected a bare hostname such as ${DEFAULT_DOMAINS[platform]}.`);
    }
    const enabled = envEnabled(env, platform) ?? entry.enabled ?? true;
    platforms[platform] = { enabled, domain };
  }

  return { token, platforms };
}

function envDomain(env, platform) {
  return env[`LINKFIX_${platform.toUpperCase()}_DOMAIN`] || undefined;
}

function envEnabled(env, platform) {
  const value = env[`LINKFIX_${platform.toUpperCase()}_ENABLED`];
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}
