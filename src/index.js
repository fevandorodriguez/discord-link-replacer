import { Client, GatewayIntentBits, Events, Partials, PermissionFlagsBits } from 'discord.js';
import { loadConfig } from './config.js';
import { announce } from './announce.js';
import { createAnnounceStore } from './admin/announce-store.js';
import { createWebhookCache } from './webhooks.js';
import { handleMessage } from './bot.js';
import { createLogBuffer } from './logbuffer.js';
import { createModeStore } from './admin/mode-store.js';
import { createAdminServer } from './admin/server.js';
import { checkMirrors } from './mirror-check.js';
import { createEchoStore } from './echoes.js';
import { handleUndoReaction, UNDO_EMOJI } from './undo.js';
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

// Same file as the mode store, for the same reason: a quip added in the panel
// has to survive the restart it exists to announce.
const announceStore = createAnnounceStore({
  channelId: config.announce.channelId,
  quips: config.announce.quips,
  file: configFile,
});

// A function rather than a list: the admin server starts before the bot logs
// in, and an empty list then is the honest answer.
//
// Written as a loop rather than filter().map().sort() so that one malformed
// entry in the channel cache costs that channel and nothing else. A throw out
// of the predicate would escape the whole filter, and the route's guard in
// src/admin/server.js would turn that into an empty dropdown with no
// explanation at all — the worst possible failure for the one control the
// operator is trying to use.
function listChannels() {
  if (!client.isReady()) return [];
  const postable = [];
  for (const channel of client.channels.cache.values()) {
    try {
      if (!channel?.isTextBased?.() || channel.isDMBased?.()) continue;
      // A channel with no string name would throw in the sort below, taking
      // the list with it. Also nothing sensible to show in the dropdown.
      if (typeof channel.name !== 'string') continue;
      // `.has?.()`, not `.has()`: the optional chains before it guard the
      // permissions object being nullish, not the method being absent on a
      // partial or otherwise odd cache entry.
      if (!channel.permissionsFor?.(client.user)?.has?.(PermissionFlagsBits.SendMessages)) continue;
      postable.push({ id: channel.id, name: channel.name });
    } catch {
      // Skip this channel, keep the rest.
    }
  }
  return postable.sort((a, b) => a.name.localeCompare(b.name));
}

// Reads the store, not the boot-time config: the panel may have changed both
// the channel and the quips since startup.
//
// The readiness check belongs here rather than in announce(), whose six
// outcomes are documented and heavily tested. Without it, a Test pressed
// before login reaches channels.fetch with no token, which rejects with
// "Expected token to be set for this request, but none was present" and
// announce() reports 'channel-missing' -- the panel then blames the channel
// for what is really "the bot has not logged in yet", during exactly the
// window the channel dropdown already warns about. It also spends the
// 30-second test cooldown on an attempt that could never have worked.
function announceNow() {
  if (!client.isReady()) return Promise.resolve('not-ready');
  const { channelId, quips } = announceStore.current();
  return announce(channelId, quips, { client, logger });
}

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
  announceStore,
  listChannels,
  announceNow,
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
    // Not privileged, so no Developer Portal change: lets the author take back
    // an echo of their own message with a reaction.
    GatewayIntentBits.GuildMessageReactions,
  ],
  // An echo can be reacted to up to an hour after it was posted, by which time
  // it is long out of the message cache. Without these the event arrives with
  // nothing usable on it.
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// Which echo the bot posted on whose behalf, so its author — and only they —
// can take it back. In memory: a restart forgets every pending undo.
const echoes = createEchoStore();

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

  // Every restart speaks. A crash loop that gets past login will repeat this
  // until someone notices; a failed login exits before reaching here.
  //
  // announce() is contractually non-throwing, but this sits in an event
  // handler where a rejection nobody awaits is noise at best, so the catch
  // costs a line and removes the question.
  announceNow().then((result) => {
    if (result !== 'sent' && result !== 'no-channel') {
      logger.warn(`Restart announcement not posted: ${result}.`);
    }
  }).catch((error) => {
    logger.error(`Restart announcement threw: ${error?.stack ?? error}`);
  });
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
      mode: modeStore.current(), platforms: config.platforms, webhooks, logger, echoes,
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

// Reacting with the undo emoji on the bot's echo of your own message takes it
// back. Every reaction in every visible channel arrives here, so the handler's
// first job is almost always to decide to do nothing.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    const outcome = await handleUndoReaction(reaction, user, { echoes, logger });
    if (outcome === 'undone') {
      // Channel name only, exactly as with a delivery outcome.
      const channel = reaction.message.channel;
      logBuffer.record('info', `undone in #${channel?.name ?? channel?.id}`);
    }
  } catch (error) {
    // A stray reaction must never take the process down either.
    logger.error(`unhandled error on reaction ${UNDO_EMOJI}: ${error.stack}`);
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
