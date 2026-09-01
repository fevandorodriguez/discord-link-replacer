// Task 5 replaces these bodies with the real page. They are real, working
// HTML so Task 4's tests exercise genuine responses rather than empty stubs.

export function renderLogin(error = '') {
  return `<!doctype html><html><body>${error}<form method="post" action="/login">` +
    `<input type="password" name="password"><button>Sign in</button></form></body></html>`;
}

export function renderDashboard() {
  return `<!doctype html><html><body><main id="app"></main></body></html>`;
}
