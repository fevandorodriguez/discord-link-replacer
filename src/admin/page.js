// The admin panel's two documents. Both are self-contained: inline CSS and
// JS, no external URLs, no build step. Neither page ever receives message
// content or a rewritten link — the log buffer that feeds the dashboard
// deliberately holds only a channel name (see src/logbuffer.js).

// Escapes untrusted text before it is interpolated into HTML. Order matters:
// '&' must be replaced first, or the entities this function inserts for the
// other four characters would themselves be re-escaped.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLogin(error = '') {
  const message = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  /* light, not "light dark": every surface below is a hardcoded light
     palette, so letting the UA render form controls dark gave white
     button text on the white backgrounds set here. */
  :root { color-scheme: light; }
  body {
    font-family: system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    background: #f4f4f5;
    color: #18181b;
  }
  form {
    background: #fff;
    color: #18181b;
    padding: 2rem;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(90vw, 320px);
  }
  h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
  input {
    padding: 0.5rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    color: #18181b;
  }
  button {
    padding: 0.5rem;
    font-size: 1rem;
    border: none;
    border-radius: 4px;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
  }
  .error { color: #b91c1c; margin: 0; font-size: 0.9rem; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Admin panel</h1>
  ${message}
  <input type="text" name="username" value="admin" autocomplete="username" readonly tabindex="-1">
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

export function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin panel</title>
<style>
  /* light, not "light dark": every surface below is a hardcoded light
     palette, so letting the UA render form controls dark gave white
     button text on the white backgrounds set here. */
  :root { color-scheme: light; }
  body {
    font-family: system-ui, sans-serif;
    margin: 0;
    padding: 1.5rem;
    background: #f4f4f5;
    color: #18181b;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }
  h1 { font-size: 1.25rem; margin: 0; }
  main { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
  section {
    background: #fff;
    color: #18181b;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; }
  .modes { display: flex; gap: 1rem; }
  .modes label { display: flex; align-items: center; gap: 0.35rem; cursor: pointer; }
  .modes label.disabled { cursor: not-allowed; opacity: 0.6; }
  .locked-note { font-size: 0.85rem; color: #92400e; margin-top: 0.5rem; }
  .mode-error { font-size: 0.85rem; color: #b91c1c; margin-top: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #e4e4e7; }
  th { color: #52525b; font-weight: 600; }
  .level-error { color: #b91c1c; }
  .level-warn { color: #b45309; }
  .level-info { color: #3f3f46; }
  form.logout { margin: 0; }
  button.logout {
    padding: 0.4rem 0.9rem;
    font-size: 0.9rem;
    border: 1px solid #d4d4d8;
    border-radius: 4px;
    background: #fff;
    color: #18181b;
    cursor: pointer;
  }
  .empty { color: #71717a; font-size: 0.85rem; }
  .field { display: block; font-size: 0.85rem; color: #52525b; margin-bottom: 0.25rem; }
  select {
    width: 100%;
    padding: 0.4rem;
    font-size: 0.9rem;
    border: 1px solid #d4d4d8;
    border-radius: 4px;
    background: #fff;
    color: #18181b;
  }
  .quips { list-style: none; margin: 0.75rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .quips li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.9rem;
    border-bottom: 1px solid #e4e4e7;
    padding-bottom: 0.35rem;
  }
  .quips li.empty { border-bottom: none; }
  .announce-add { display: flex; gap: 0.5rem; }
  .announce-add input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem;
    font-size: 0.9rem;
    border: 1px solid #d4d4d8;
    border-radius: 4px;
    background: #fff;
    color: #18181b;
  }
  .announce-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; align-items: center; }
  section button {
    padding: 0.4rem 0.9rem;
    font-size: 0.9rem;
    border: 1px solid #d4d4d8;
    border-radius: 4px;
    background: #fff;
    color: #18181b;
    cursor: pointer;
  }
  section button:disabled { opacity: 0.6; cursor: not-allowed; }
  .announce-note { font-size: 0.85rem; color: #3f3f46; margin: 0.5rem 0 0; }
  .unsaved { font-size: 0.85rem; color: #b45309; margin: 0.5rem 0 0; }
  .hint { font-size: 0.8rem; color: #71717a; margin: 0.5rem 0 0; }
</style>
</head>
<body>
<header>
  <h1>Admin panel</h1>
  <form class="logout" method="post" action="/logout"><button class="logout" type="submit">Sign out</button></form>
</header>
<main>
  <section>
    <h2>Delivery mode</h2>
    <div class="modes" id="modes">
      <label><input type="radio" name="mode" value="repost" disabled> repost</label>
      <label><input type="radio" name="mode" value="suppress" disabled> suppress</label>
    </div>
    <div id="mode-status"></div>
  </section>
  <section>
    <h2>Restart announcement</h2>
    <label class="field" for="announce-channel">Channel</label>
    <select id="announce-channel"><option value="">No announcements</option></select>
    <p class="hint" id="announce-channel-hint" hidden></p>
    <ul class="quips" id="announce-quips"></ul>
    <div class="announce-add">
      <input type="text" id="announce-quip" placeholder="Add a quip" maxlength="2000">
      <button type="button" id="announce-add">Add</button>
    </div>
    <div class="announce-actions">
      <button type="button" id="announce-save">Save</button>
      <button type="button" id="announce-test">Test</button>
    </div>
    <p class="hint">Test posts one of the <em>saved</em> quips straight away, at most once every 30 seconds.</p>
    <p class="unsaved" id="announce-unsaved" hidden>Unsaved changes. Press Save.</p>
    <div id="announce-status"></div>
  </section>
  <section>
    <h2>Recent activity</h2>
    <div id="activity"><p class="empty">Loading…</p></div>
  </section>
</main>
<script>
(function () {
  var modesEl = document.getElementById('modes');
  var statusEl = document.getElementById('mode-status');
  var activityEl = document.getElementById('activity');
  var channelEl = document.getElementById('announce-channel');
  var channelHintEl = document.getElementById('announce-channel-hint');
  var quipsEl = document.getElementById('announce-quips');
  var quipInputEl = document.getElementById('announce-quip');
  var announceStatusEl = document.getElementById('announce-status');
  var unsavedEl = document.getElementById('announce-unsaved');
  var addQuipEl = document.getElementById('announce-add');
  var saveAnnounceEl = document.getElementById('announce-save');
  var testAnnounceEl = document.getElementById('announce-test');

  // The working copy of the quip list. Edits live here and nothing reaches
  // config.json until Save posts the whole { channelId, quips } object, so a
  // half-finished edit can be abandoned by reloading the page.
  var quips = [];

  // Every outcome the test endpoint can return, as a sentence. Anything not in
  // here is a bug rather than a state the operator can act on, so it is
  // reported verbatim instead of being flattened into a friendly lie.
  //
  // 'not-ready' is the wrapper's, not announce()'s: the panel is up before the
  // bot has logged in, and a test in that window used to come back as
  // 'channel-missing' — blaming the channel for a missing Discord session.
  var TEST_RESULTS = {
    'sent': 'Posted.',
    'no-channel': 'Pick a channel first.',
    'no-quips': 'Add a quip first.',
    'not-ready': 'The bot is still starting and has not logged in to Discord yet. Wait a moment and try again.',
    'channel-missing': 'The bot cannot see that channel.',
    'not-postable': 'The bot cannot post there.',
    'failed': 'Discord rejected it.'
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // text() and a guarded parse, never res.json(): a refusal that isn't JSON
  // makes res.json() throw, so the whole chain lands in the caller's catch
  // and reports that the server could not be reached. It plainly could -- it
  // answered. The likeliest such refusal is not even ours: Caddy sits in
  // front of this and answers its own limits with an HTML error page.
  function readResult(res) {
    return res.text().then(function (text) {
      var body = {};
      try {
        body = JSON.parse(text) || {};
      } catch (e) {
        body = {};
      }
      return { ok: res.ok, status: res.status, body: body };
    });
  }

  function renderModes(state) {
    var radios = ['repost', 'suppress'].map(function (mode) {
      var checked = state.mode === mode ? ' checked' : '';
      var disabled = state.locked ? ' disabled' : '';
      var cls = state.locked ? ' class="disabled"' : '';
      return '<label' + cls + '><input type="radio" name="mode" value="' + mode + '"' +
        checked + disabled + '> ' + mode + '</label>';
    }).join('');
    modesEl.innerHTML = radios;

    if (state.locked) {
      statusEl.innerHTML = '<p class="locked-note">Mode is fixed by LINKFIX_MODE in the ' +
        'environment; unset it to control the mode from here.</p>';
    } else {
      statusEl.innerHTML = '';
      var inputs = modesEl.querySelectorAll('input[type="radio"]');
      inputs.forEach(function (input) {
        input.addEventListener('change', function () {
          setMode(input.value);
        });
      });
    }
  }

  function renderActivity(entries) {
    if (!entries.length) {
      activityEl.innerHTML = '<p class="empty">Nothing yet.</p>';
      return;
    }
    var rows = entries.slice().reverse().map(function (entry) {
      return '<tr><td>' + escapeHtml(entry.at) + '</td>' +
        '<td class="level-' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</td>' +
        '<td>' + escapeHtml(entry.text) + '</td></tr>';
    }).join('');
    activityEl.innerHTML = '<table><thead><tr><th>Time</th><th>Level</th><th>Event</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function refresh() {
    fetch('/api/state').then(function (res) {
      if (res.status === 401) {
        window.location.href = '/';
        return null;
      }
      return res.json();
    }).then(function (state) {
      if (!state) return;
      renderModes(state);
      renderActivity(state.entries || []);
    }).catch(function () {
      // A transient poll failure is not worth surfacing; the next tick retries.
    });
  }

  function setMode(mode) {
    fetch('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    }).then(readResult).then(function (result) {
      if (!result.ok) {
        statusEl.innerHTML = '<p class="mode-error">' + escapeHtml(result.body.error || ('The server refused the change (HTTP ' + result.status + ').')) + '</p>';
      }
      refresh();
    }).catch(function () {
      statusEl.innerHTML = '<p class="mode-error">Could not reach the server.</p>';
    });
  }

  // Quips and channel names are free text: a quip is whatever was typed into
  // the box below, and a forum or voice channel name allows far more than the
  // lowercase-and-dashes a text channel is limited to. Everything below builds
  // nodes and assigns textContent rather than concatenating markup, so there
  // is no escaping to forget — note that the escapeHtml above is a *second*
  // copy of the module-level one and only the in-script copy is in scope here.
  // The unsaved marker gets its own element, not the status line. They answer
  // different questions -- "is the server holding what you see?" versus "what
  // happened just now?" -- and routing both through one element means the
  // first is destroyed by the second at the worst possible moment: press Test
  // with edits pending and "Unsaved changes" is replaced by "Posted.", which
  // reads as confirmation that the quip you just added is the one that went
  // out. It isn't; Test posts what was last saved. Both facts now sit on
  // screen together.
  function setUnsaved(unsaved) {
    unsavedEl.hidden = !unsaved;
  }

  function setAnnounceStatus(text, kind) {
    announceStatusEl.textContent = '';
    if (!text) return;
    var line = document.createElement('p');
    line.className = kind === 'error' ? 'mode-error' : 'announce-note';
    line.textContent = text;
    announceStatusEl.appendChild(line);
  }

  function renderQuips() {
    quipsEl.textContent = '';
    if (!quips.length) {
      var none = document.createElement('li');
      none.className = 'empty';
      none.textContent = 'No quips yet — the bot stays quiet on restart until there is at least one.';
      quipsEl.appendChild(none);
      return;
    }
    quips.forEach(function (quip, index) {
      var row = document.createElement('li');
      var text = document.createElement('span');
      text.textContent = quip;
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        quips.splice(index, 1);
        renderQuips();
        setUnsaved(true);
      });
      row.appendChild(text);
      row.appendChild(remove);
      quipsEl.appendChild(row);
    });
  }

  function renderChannels(channels, channelId) {
    channelEl.textContent = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'No announcements';
    channelEl.appendChild(none);

    var found = false;
    channels.forEach(function (channel) {
      var option = document.createElement('option');
      option.value = channel.id;
      option.textContent = '#' + channel.name;
      channelEl.appendChild(option);
      if (channel.id === channelId) found = true;
    });

    // A saved channel the bot can no longer see (renamed guild, revoked
    // permission, bot not logged in yet) would otherwise silently snap the
    // dropdown back to "No announcements", and the next Save would quietly
    // throw the setting away.
    if (channelId && !found) {
      var missing = document.createElement('option');
      missing.value = channelId;
      missing.textContent = 'Channel ' + channelId + ' (not visible to the bot)';
      channelEl.appendChild(missing);
    }
    channelEl.value = channelId || '';

    channelHintEl.hidden = channels.length > 0;
    if (!channels.length) {
      channelHintEl.textContent = 'No channels to offer yet — the panel starts before the bot logs in. Reload once it is up.';
    }
  }

  // Loaded once, not on the 5s tick: re-fetching would overwrite whatever the
  // operator is halfway through typing.
  function loadAnnounce() {
    fetch('/api/announce').then(function (res) {
      if (res.status === 401) {
        window.location.href = '/';
        return null;
      }
      return res.json();
    }).then(function (data) {
      if (!data) return;
      quips = (data.quips || []).slice();
      renderChannels(data.channels || [], data.channelId || '');
      renderQuips();
      // What is on screen is exactly what the server holds.
      setUnsaved(false);
    }).catch(function () {
      setAnnounceStatus('Could not load the announcement settings.', 'error');
    });
  }

  function addQuip() {
    var text = quipInputEl.value.trim();
    if (!text) return;
    quips.push(text);
    quipInputEl.value = '';
    renderQuips();
    setUnsaved(true);
  }

  function saveAnnounce() {
    saveAnnounceEl.disabled = true;
    fetch('/api/announce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: channelEl.value, quips: quips }),
    }).then(readResult).then(function (result) {
      if (!result.ok) {
        setAnnounceStatus(result.body.error || ('The server refused the save (HTTP ' + result.status + ').'), 'error');
        return;
      }
      // Redraw from what the server stored rather than from the local list:
      // the two agreeing is the point of pressing Save.
      quips = (result.body.quips || []).slice();
      channelEl.value = result.body.channelId || '';
      renderQuips();
      // Cleared only on success: a rejected save leaves the edits pending and
      // the marker standing, which is the truth of the situation.
      setUnsaved(false);
      setAnnounceStatus('Saved.');
    }).catch(function () {
      setAnnounceStatus('Could not reach the server.', 'error');
    }).then(function () {
      saveAnnounceEl.disabled = false;
    });
  }

  // The 30-second server-side cooldown is the real guard; disabling the button
  // only stops a double-click turning into a wasted 429.
  function testAnnounce() {
    testAnnounceEl.disabled = true;
    setAnnounceStatus('Testing…');
    fetch('/api/announce/test', { method: 'POST' }).then(readResult).then(function (result) {
      if (!result.ok) {
        setAnnounceStatus(result.body.error || ('The server refused the test (HTTP ' + result.status + ').'), 'error');
        return;
      }
      var outcome = result.body.result;
      var sentence = TEST_RESULTS[outcome] || ('Unexpected result: ' + outcome + '.');
      setAnnounceStatus(sentence, outcome === 'sent' ? 'note' : 'error');
    }).catch(function () {
      setAnnounceStatus('Could not reach the server.', 'error');
    }).then(function () {
      testAnnounceEl.disabled = false;
    });
  }

  channelEl.addEventListener('change', function () {
    setUnsaved(true);
  });
  addQuipEl.addEventListener('click', addQuip);
  quipInputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addQuip();
    }
  });
  saveAnnounceEl.addEventListener('click', saveAnnounce);
  testAnnounceEl.addEventListener('click', testAnnounce);

  refresh();
  setInterval(refresh, 5000);
  loadAnnounce();
})();
</script>
</body>
</html>`;
}
