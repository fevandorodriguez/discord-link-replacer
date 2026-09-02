// The mirror domains this bot rewrites to are volunteer-run and die regularly.
// Four died during one afternoon: two lost their DNS records, one was taken
// down by a legal request, and one was blocked by the platform it mirrors.
//
// The two that mattered most both answered HTTP 200 while serving an error
// page, so a status check called them healthy. That is why this reads the
// response BODY: a mirror that returns 200 and the words "no longer available"
// is broken in exactly the way that matters, and the status code says nothing.
const FAILURE_PHRASES = [
  [/legal request|no longer available|has been (taken down|discontinued)/i, 'takedown'],
  [/blocked the request|actively preventing|access denied/i, 'blocked by the platform'],
  [/(account|service) has been suspended/i, 'suspended'],
  [/domain (is )?for sale|buy this domain|parked (free )?(domain|page)/i, 'parked domain'],
  [/rate limit(ed)?|too many requests/i, 'rate limited'],
];

const DISCORD_UA = 'Discordbot/2.0; +https://discordapp.com';

// Checks one domain. Never throws: a health check that can crash the process it
// monitors is worse than no health check.
// `path` defaults to the root, which catches a domain that has died outright —
// lost DNS, parked, or taken down. It does NOT catch a mirror whose root serves
// normally while every real post fails, which is how rxddit died: Reddit blocked
// it at the API, so the front page looked fine and every link returned a block
// notice. Point `path` at a real post to catch that class.
export async function checkMirror(domain, { fetchImpl = fetch, timeoutMs = 10000, path = '/' } = {}) {
  const result = (ok, reason) => ({ domain, ok, reason });

  let body;
  let status;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Identify as Discord so the mirror serves whatever it would serve the
      // crawler whose embeds we are trying to fix, rather than a browser page.
      const response = await fetchImpl(`https://${domain}${path}`, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': DISCORD_UA },
      });
      status = response.status;
      body = await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return result(false, `unreachable: ${error?.message ?? error}`);
  }

  if (typeof body !== 'string' || body.trim().length === 0) {
    return result(false, `empty response (HTTP ${status})`);
  }
  // Match against visible text only. A healthy mirror flagged itself because it
  // ships its own UI translations inline — including the *text* of its
  // rate-limit message — so the checker found the words for an error on a page
  // that was working perfectly. A real takedown or block notice is rendered
  // content; a string a page might one day display lives in its scripts.
  //
  // Judging by OpenGraph tags instead was tried and is worse: a takedown notice
  // carries og:title too, so it let a dead mirror through.
  const visible = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  for (const [pattern, label] of FAILURE_PHRASES) {
    if (pattern.test(visible)) return result(false, `${label} (HTTP ${status})`);
  }
  if (status >= 500) return result(false, `HTTP ${status}`);

  return result(true, 'ok');
}

// Checks every enabled platform's configured mirror. Disabled platforms are
// skipped: their domain is not in use, so its health is not interesting.
export async function checkMirrors(platforms, deps = {}) {
  const enabled = Object.entries(platforms).filter(([, s]) => s?.enabled);
  return Promise.all(
    enabled.map(async ([platform, settings]) => ({
      platform,
      // A platform may name a real post to fetch instead of the root, which is
      // the only way to see a mirror that is blocked at the API rather than dead.
      ...(await checkMirror(settings.domain, { ...deps, path: settings.canary ?? '/' })),
    })),
  );
}
