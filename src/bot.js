import { PermissionFlagsBits } from 'discord.js';
import { rewrite } from './rewrite.js';

const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.SendMessages,
];

// MessageReferenceType.Forward === 1. A forwarded message carries content we
// cannot reproduce through a webhook, so it is left alone.
const REFERENCE_TYPE_FORWARD = 1;

export function ignoreReason(message, botUserId) {
  if (message.author?.bot) return 'bot';
  if (message.webhookId) return 'webhook';
  if (!message.guild) return 'not-a-guild';
  if (message.system) return 'system';
  if (message.attachments?.size > 0) return 'has-attachments';
  if (message.stickers?.size > 0) return 'has-stickers';
  if (message.poll) return 'has-poll';
  if (message.reference?.type === REFERENCE_TYPE_FORWARD) return 'forwarded';

  const permissions = message.channel.permissionsFor(botUserId);
  if (!permissions || !REQUIRED_PERMISSIONS.every((flag) => permissions.has(flag))) {
    return 'missing-permissions';
  }
  return null;
}

export function buildPayload(message, content) {
  const isReply = message.reference?.type !== REFERENCE_TYPE_FORWARD && message.reference?.messageId;
  const repliedTo = message.mentions?.repliedUser?.id;
  // A webhook cannot carry a reply reference, so the link becomes a subtext line.
  // If the replied-to user isn't resolvable (they left, or the message is
  // uncached), the subtext line is silently dropped rather than abandoning
  // the rewrite — this is intended graceful degradation, not a bug.
  const body = isReply && repliedTo ? `-# ↪ replying to <@${repliedTo}>\n${content}` : content;

  const payload = {
    content: body,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.member?.displayAvatarURL() ?? message.author.displayAvatarURL(),
    // Mentions still render, but nobody the original already pinged gets a
    // second notification.
    allowedMentions: { parse: [] },
  };
  if (message.channel.isThread?.()) payload.threadId = message.channel.id;
  return payload;
}

// Discord API error: the channel already has the maximum 15 webhooks.
const ERROR_MAX_WEBHOOKS = 30007;

export async function handleMessage(message, { platforms, webhooks, logger }) {
  const reason = ignoreReason(message, message.client?.user?.id);
  if (reason) return reason;

  const { changed, content } = rewrite(message.content, platforms);
  if (!changed) return 'unchanged';

  const payload = buildPayload(message, content);

  let webhook;
  try {
    webhook = await webhooks.get(message.channel);
  } catch (error) {
    if (error.code === ERROR_MAX_WEBHOOKS) {
      // Channel is out of webhook slots: post the fixed link plainly and
      // leave the original in place rather than destroying it.
      try {
        await message.reply({ content, allowedMentions: { parse: [] } });
      } catch (replyError) {
        logger.error(`fallback reply failed in ${message.channel.id}: ${replyError.message}`);
        return 'send-failed';
      }
      return 'fallback-reply';
    }
    logger.error(`webhook lookup failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  try {
    await webhook.send(payload);
  } catch (error) {
    logger.error(`webhook send failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  try {
    await message.delete();
  } catch (error) {
    // The replacement is already posted; a failed delete leaves a duplicate,
    // which is noisy but not destructive.
    logger.warn(`could not delete ${message.id}: ${error.message}`);
  }
  return 'replaced';
}
