// Reacting with this on the bot's echo of your own message takes it back.
// Exact match only — a shooting star, not a star, sparkles, or a glowing star.
export const UNDO_EMOJI = '🌠';

// The bot receives every reaction in every channel it can see, so almost all of
// this function's work is deciding to do nothing. It acts only on messages the
// echo store recognises, and only for the person the echo was posted on behalf
// of. Never throws: a stray reaction must not be able to take the process down.
export async function handleUndoReaction(reaction, user, { echoes, logger }) {
  if (user?.bot) return 'ignored';
  if (reaction.emoji?.name !== UNDO_EMOJI) return 'ignored';

  const { verdict, originalId } = echoes.claim(reaction.message.id, user.id);

  // Not an echo, or the window has passed. Leave the reaction alone — this
  // emoji belongs to the channel, not to the bot.
  if (verdict === 'unknown') return 'ignored';

  if (verdict === 'not-author') {
    // Reactions cannot carry a private reply — that needs an interaction — so
    // removing theirs is the only feedback available that says "that did
    // nothing" without putting a word in the channel.
    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      logger.warn(`could not remove a stray undo reaction on ${reaction.message.id}: ${error.message}`);
    }
    return 'refused';
  }

  // Suppress mode only: the author's message still exists, with its embed
  // stripped. Give that back BEFORE removing the reply. The reverse order,
  // failing halfway, would leave them with a suppressed embed and no fixed
  // link — worse off than if the bot had never touched the message.
  if (originalId) {
    try {
      const original = await reaction.message.channel.messages.fetch(originalId);
      await original.suppressEmbeds(false);
    } catch (error) {
      // The reply is still there and still works; an unrestored embed is
      // untidy rather than harmful, so the undo continues.
      logger.warn(`could not restore the embed on ${originalId}: ${error.message}`);
    }
  }

  try {
    await reaction.message.delete();
  } catch (error) {
    logger.error(`could not delete echo ${reaction.message.id}: ${error.message}`);
    return 'delete-failed';
  }
  return 'undone';
}
