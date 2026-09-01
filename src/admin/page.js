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
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    background: #f4f4f5;
  }
  form {
    background: #fff;
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
  :root { color-scheme: light dark; }
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
    cursor: pointer;
  }
  .empty { color: #71717a; font-size: 0.85rem; }
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
    <h2>Recent activity</h2>
    <div id="activity"><p class="empty">Loading…</p></div>
  </section>
</main>
<script>
(function () {
  var modesEl = document.getElementById('modes');
  var statusEl = document.getElementById('mode-status');
  var activityEl = document.getElementById('activity');

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, body: body };
      });
    }).then(function (result) {
      if (!result.ok) {
        statusEl.innerHTML = '<p class="mode-error">' + escapeHtml(result.body.error || 'Could not change mode.') + '</p>';
      }
      refresh();
    }).catch(function () {
      statusEl.innerHTML = '<p class="mode-error">Could not reach the server.</p>';
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
