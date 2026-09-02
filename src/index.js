import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { createWebhookCache } from './webhooks.js';
import { handleMessage } from './bot.js';
import { createLogBuffer } from './logbuffer.js';
import { createModeStore } from './admin/mode-store.js';
import { createAdminServer } from './admin/server.js';
import { checkMirrors } from './mirror-check.js';
import { randomBytes } from 'node:crypto';

const logBuffer = createLogBuffer();
const logger = logBuffer.attach(console);

// Resolved once and shared by loadConfig and the mode store below, so both
// read from (and the panel's toggle writes to) the same file. Previously
// loadConfig() always used its own 'config.json' default while the mode
// store alone honored LINKFIX_CONFIG_FILE -- harmless while the two
// happened to coincide, but a real config-file-and-live-mode mismatch as
// soon as they didn't (see the Docker deploy layout in compose.yml, which
// now sets this env var).
const configFile = process.env.LINKFIX_CONFIG_FILE ?? 'config.json';

let config;
try {
  config = loadConfig({ file: configFile });
} catch (error) {
  logger.error(error.message);
  process.exit(1);
}

const modeStore = createModeStore({
  mode: config.mode,
  modeSource: config.modeSource,
  file: configFile,
});

// Unset OR EMPTY SESSION_SECRET means sessions do not survive a restart.
// `||`, not `??`: `??` only falls through on null/undefined, and an .env
// line left as `SESSION_SECRET=` -- easy to end up with by uncommenting
// .env.example's line without filling it in -- reads back through
// docker compose's env_file as the empty string, not "unset". `??` would
// sign every session with that publicly-known empty key. createAdminServer
// in src/admin/server.js refuses an empty/short secret outright too, as a
// second, independent layer of defence.
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const admin = createAdminServer({
  modeStore,
  logBuffer,
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  sessionSecret,
  logger,
});
if (admin) {
  const port = Number(process.env.ADMIN_PORT ?? 3000);
  admin.listen(port, () => logger.info(`Admin panel listening on ${port}`));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged: enable "Message Content Intent" in the Developer Portal or
    // every message arrives with empty content.
    GatewayIntentBits.MessageContent,
  ],
});

// The cache needs the bot's own user ID, which is known only after login.
let webhooks = null;
// Channels we have already complained about, so a misconfigured channel
// warns once rather than once per message.
const warnedChannels = new Set();

client.once(Events.ClientReady, (ready) => {
  webhooks = createWebhookCache(ready.user.id);
  const enabled = Object.entries(config.platforms)
    .filter(([, s]) => s.enabled)
    .map(([name, s]) => `${name}→${s.domain}`)
    .join(', ');
  logger.info(`Logged in as ${ready.user.tag} in ${config.mode} mode (from ${config.modeSource}). Rewriting: ${enabled || 'nothing'}`);
  startMirrorChecks();
});

// These mirrors are volunteer-run and die without notice — four died in a
// single afternoon, and the two that mattered most kept answering HTTP 200
// while serving an error page, so nothing looked wrong until someone posted a
// link. Check on boot and daily thereafter, and say so loudly: a mirror that
// has died is rewriting every link to a broken page, which is worse than not
// rewriting at all.
const MIRROR_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runMirrorCheck() {
  let results;
  try {
    results = await checkMirrors(config.platforms);
  } catch (error) {
    // A health check must never be the thing that takes the bot down.
    logger.error(`mirror check failed to run: ${error?.message ?? error}`);
    return;
  }

  const broken = results.filter((r) => !r.ok);
  if (broken.length === 0) {
    logger.info(`Mirror check: all ${results.length} reachable.`);
    return;
  }
  for (const { platform, domain, reason } of broken) {
    logger.error(`Mirror check: ${platform} → ${domain} looks broken (${reason}). Links for this platform are being rewritten to a page that does not work.`);
  }
}

function startMirrorChecks() {
  runMirrorCheck();
  const timer = setInterval(runMirrorCheck, MIRROR_CHECK_INTERVAL_MS);
  // Don't hold the process open on shutdown for a check that can wait a day.
  timer.unref?.();
}

client.on(Events.MessageCreate, async (message) => {
  if (!webhooks) return; // not logged in yet
  try {
    const outcome = await handleMessage(message, {
      mode: modeStore.current(), platforms: config.platforms, webhooks, logger,
    });
    if (outcome === 'replaced' || outcome === 'suppressed' || outcome === 'fallback-reply') {
      // Channel name only — never the message or the link.
      logBuffer.record('info', `${outcome} in #${message.channel.name ?? message.channel.id}`);
    }
    if (outcome === 'missing-permissions' && !warnedChannels.has(message.channel.id)) {
      warnedChannels.add(message.channel.id);
      // Suppress mode never touches a webhook, so naming Manage Webhooks here
      // would point at a permission this mode doesn't need.
      const requiredPermissions = config.mode === 'suppress'
        ? 'Manage Messages / Send Messages'
        : 'Manage Messages / Manage Webhooks / Send Messages';
      logger.warn(`Missing ${requiredPermissions} in #${message.channel.name ?? message.channel.id}; skipping this channel.`);
    }
  } catch (error) {
    // One bad message must never take the process down.
    logger.error(`unhandled error on message ${message.id}: ${error.stack}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    logger.info(`${signal} received, shutting down.`);
    // destroy() is async; exiting before it settles truncates the disconnect.
    await client.destroy();
    admin?.close();
    process.exit(0);
  });
}

process.on('unhandledRejection', (error) => {
  logger.error(`unhandled rejection: ${error?.stack ?? error}`);
});

// An unhandled login rejection would otherwise exit 0, which under
// `restart: unless-stopped` is a silent crash-loop reporting success. The two
// failures that land here are TokenInvalid and DisallowedIntents (Message
// Content not enabled in the Developer Portal), both of which need a human.
client.login(config.token).catch((error) => {
  logger.error(`login failed: ${error.message}`);
  process.exit(1);
});
