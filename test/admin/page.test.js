import { describe, it, expect } from 'vitest';
import { renderLogin, renderDashboard } from '../../src/admin/page.js';

describe('login page', () => {
  it('posts a password field to /login', () => {
    const html = renderLogin();
    expect(html).toContain('action="/login"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="password"');
  });

  it('carries the autocomplete hints a password manager needs', () => {
    const html = renderLogin();
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="username"');
  });

  it('shows an error when given one', () => {
    expect(renderLogin('Incorrect password.')).toContain('Incorrect password.');
  });

  it('escapes the error rather than injecting it as markup', () => {
    expect(renderLogin('<script>alert(1)</script>')).not.toContain('<script>alert(1)</script>');
  });
});

describe('dashboard', () => {
  it('is a complete document with no external asset references', () => {
    const html = renderDashboard();
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  it('polls the state API and offers both modes', () => {
    const html = renderDashboard();
    expect(html).toContain('/api/state');
    expect(html).toContain('repost');
    expect(html).toContain('suppress');
  });
});

describe('dashboard — announcements', () => {
  it('has a channel picker and a quip editor', () => {
    const html = renderDashboard();
    expect(html).toContain('/api/announce');
    expect(html).toMatch(/<select[^>]*id="announce-channel"/);
    expect(html).toContain('announce-quips');
  });

  it('has a test button that calls the test endpoint', () => {
    expect(renderDashboard()).toContain('/api/announce/test');
  });

  it('is still one self-contained document with no external assets', () => {
    const html = renderDashboard();
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  it('maps every announce outcome to a plain sentence', () => {
    const html = renderDashboard();
    for (const outcome of ['sent', 'no-channel', 'no-quips', 'channel-missing', 'not-postable', 'failed']) {
      expect(html).toContain(`'${outcome}'`);
    }
    expect(html).toContain('Pick a channel first');
    expect(html).toContain('Add a quip first');
    expect(html).toContain('cannot see that channel');
    expect(html).toContain('cannot post there');
    expect(html).toContain('Discord rejected it');
  });

  it('has a sentence for a test pressed before the bot has logged in', () => {
    const html = renderDashboard();
    // Pressing Test before login used to answer 'channel-missing' -> "The bot
    // cannot see that channel", blaming the channel for what is really "there
    // is no logged-in client yet". announceNow() now short-circuits with its
    // own outcome, and the panel has to name the real cause.
    expect(html).toContain(`'not-ready'`);
    expect(html).toMatch(/not-ready'\s*:\s*'[^']*still starting[^']*'/);
  });

  it('keeps the unsaved-changes marker out of the transient status line', () => {
    const html = renderDashboard();
    // Its own element, hidden until there is something to warn about.
    expect(html).toMatch(/<p[^>]*id="announce-unsaved"[^>]*hidden[^>]*>Unsaved changes\. Press Save\.<\/p>/);
    // Never routed through setAnnounceStatus: Test overwrites that line with
    // "Testing…" and then the outcome, so putting the marker there means
    // pressing Test with edits pending replaces "Unsaved changes" with
    // "Posted." — which reads as confirmation that the pending quip is the
    // one that went out. It isn't. Both facts must survive together.
    expect(html).not.toMatch(/setAnnounceStatus\(\s*'Unsaved/);
    // Shown and cleared, so the marker cannot be permanently hidden (silently
    // losing the warning) or permanently shown (surviving a successful save).
    expect(html).toContain('setUnsaved(true)');
    expect(html).toContain('setUnsaved(false)');
  });

  it('reports what the server said about a refused save, not a network error', () => {
    const html = renderDashboard();
    // A save the server refuses (413 for an oversized list, 400 for a quip
    // the validator rejects) now comes back as a real response. Reading it
    // must not depend on the body parsing as JSON: in production Caddy sits
    // in front and answers its own limits with an HTML error page, and
    // res.json() throwing on that would drop the whole thing into the catch
    // below and print "Could not reach the server." — which is a lie about a
    // server that plainly answered.
    expect(html).toMatch(/saveAnnounce[\s\S]*?res\.text\(\)/);
    expect(html).toMatch(/saveAnnounce[\s\S]*?JSON\.parse/);
    // An answer with no readable error still names the status code, so the
    // operator has something to search for rather than a shrug.
    expect(html).toContain('The server refused the save');
  });

  it('builds quip and channel text as DOM text rather than interpolated markup', () => {
    const html = renderDashboard();
    // Quips and channel names are free text from /api/announce. They are
    // appended with textContent, so there is no markup path to escape.
    expect(html).toContain('textContent');
    expect(html).toMatch(/createElement\('option'\)/);
  });
});
