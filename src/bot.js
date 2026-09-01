import { PermissionFlagsBits } from 'discord.js';
import { rewrite } from './rewrite.js';
import { deliver as repostDeliver } from './delivery/repost.js';

const BASE_PERMISSIONS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.SendMessages,
];
// Only repost posts through a webhook.
const REPOST_PERMISSIONS = [...BASE_PERMISSIONS, PermissionFlagsBits.ManageWebhooks];

// MessageReferenceType.Forward === 1. A forwarded message carries content we
// cannot reproduce through a webhook, so it is left alone.
const REFERENCE_TYPE_FORWARD = 1;

export function ignoreReason(message, botUserId, mode) {
  if (message.author?.bot) return 'bot';
  if (message.webhookId) return 'webhook';
  if (!message.guild) return 'not-a-guild';
  if (message.system) return 'system';

  // These four exist only to stop repost destroying content a webhook cannot
  // reproduce. Suppress mode deletes nothing, so it handles them normally.
  // Branch written as "not suppress" rather than "is repost" so an unrecognised
  // mode defaults to the guarded path instead of the permissive one.
  if (mode !== 'suppress') {
    if (message.attachments?.size > 0) return 'has-attachments';
    if (message.stickers?.size > 0) return 'has-stickers';
    if (message.poll) return 'has-poll';
    if (message.reference?.type === REFERENCE_TYPE_FORWARD) return 'forwarded';
  }

  const required = mode !== 'suppress' ? REPOST_PERMISSIONS : BASE_PERMISSIONS;
  const permissions = message.channel.permissionsFor(botUserId);
  if (!permissions || !required.every((flag) => permissions.has(flag))) {
    return 'missing-permissions';
  }

  // Suppress mode still posts an embed on the author's behalf, so even though
  // it does not use a webhook, a server that denied this user Embed Links is
  // still being overridden. This check applies to both modes: it is not mode-gated.
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
