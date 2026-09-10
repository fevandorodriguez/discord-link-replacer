import { PermissionFlagsBits } from 'discord.js';

// Says something in the configured channel. Returns an outcome rather than
// throwing: the test button needs to report the reason, and a bot that cannot
// make a joke must still start up.
export async function announce(channelId, quips, { client, logger, pick } = {}) {
  if (!channelId) return 'no-channel';
  if (!Array.isArray(quips) || quips.length === 0) return 'no-quips';

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    logger.warn(`announce: could not find channel ${channelId}: ${error.message}`);
    return 'channel-missing';
  }
  if (!channel || !channel.isTextBased?.()) {
    logger.warn(`announce: ${channelId} is not a channel this bot can post in.`);
    return 'channel-missing';
  }

  // A channel the bot can see but not speak in fails silently at send time,
  // which is exactly the confusion the test button exists to remove.
  if (!channel.permissionsFor?.(client.user)?.has(PermissionFlagsBits.SendMessages)) {
    logger.warn(`announce: missing Send Messages in ${channelId}.`);
    return 'not-postable';
  }

  const choose = pick ?? (() => Math.floor(Math.random() * quips.length));
  const content = quips[choose()];

  try {
    // parse: [] is not cosmetic. Quips are free text set through a
    // password-gated web page; without it, one containing @everyone would
    // ping the whole server on every restart.
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error(`announce: send failed in ${channelId}: ${error.message}`);
    return 'failed';
  }
  return 'sent';
}
