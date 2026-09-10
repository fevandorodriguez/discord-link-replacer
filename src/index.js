import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { createWebhookCache } from './webhooks.js';
import { handleMessage } from './bot.js';

const logger = console;

let config;
try {
  config = loadConfig();
} catch (error) {
  logger.error(error.message);
  process.exit(1);
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
});

client.on(Events.MessageCreate, async (message) => {
  if (!webhooks) return; // not logged in yet
  try {
    const outcome = await handleMessage(message, {
      mode: config.mode, platforms: config.platforms, webhooks, logger,
    });
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
