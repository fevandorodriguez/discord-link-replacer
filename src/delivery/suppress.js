// Discord does not let a bot edit another user's message — authorship is
// immutable. But with Manage Messages it can strip the message's embed, which
// is enough: the author's text stays exactly as written and the working embed
// arrives in a reply.
export async function deliver(message, content, { logger }) {
  try {
    // parse: [] keeps mentions rendering without re-notifying anyone the
    // original already pinged; repliedUser: false stops the reply pinging
    // the author about their own link.
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  } catch (error) {
    logger.error(`reply failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  // Reply first, suppress second. Suppressing before a confirmed reply could
  // strip the author's embed and then give nothing back.
  try {
    await message.suppressEmbeds(true);
  } catch (error) {
    // The fixed link is already posted; a failed suppression leaves the broken
    // embed alongside it, which is untidy but not harmful.
    logger.warn(`could not suppress embeds on ${message.id}: ${error.message}`);
  }
  return 'suppressed';
}
