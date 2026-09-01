import { PermissionFlagsBits } from 'discord.js';
import { rewrite } from './rewrite.js';
import { deliver as repostDeliver } from './delivery/repost.js';

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

  // A webhook message is not subject to the posting member's permissions, so
  // in a channel where the author is denied Embed Links — a common anti-scam
  // setting, and the exact permission this bot exists to exercise — reposting
  // would do for them something the server has explicitly denied them. Fail
  // closed: the server's moderation intent wins over the embed.
  const authorPermissions = message.channel.permissionsFor(message.member ?? message.author);
  if (!authorPermissions || !authorPermissions.has(PermissionFlagsBits.EmbedLinks)) {
    return 'author-cannot-embed';
  }
  return null;
}

export async function handleMessage(message, { platforms, webhooks, logger }) {
  const reason = ignoreReason(message, message.client?.user?.id);
  if (reason) return reason;

  const { changed, content } = rewrite(message.content, platforms);
  if (!changed) return 'unchanged';

  return repostDeliver(message, content, { webhooks, logger });
}
