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
