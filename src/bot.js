import { PermissionFlagsBits } from 'discord.js';

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
