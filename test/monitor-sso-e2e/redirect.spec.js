import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler, { makeToken } from '../../proxy/src/handler.js';
import { memoryStore, saveUser } from '../../proxy/src/users.js';

const DASHBOARD = 'https://dashboard.ai1.host';
const MONITOR = 'https://monitor.ai1.host';
const PROXY = 'https://aione-team-proxy.vercel.app';
const people = {
  alice: { id: 'e2e-alice-00000000001', email: 'alice@example.invalid', name: 'Alice', role: 'admin', v: 1 },
  bob: { id: 'e2e-bob-0000000000002', email: 'bob@example.invalid', name: 'Bob', role: 'admin', v: 1 },
  // Signed in to Team Control, but no administrator has linked this account to AI1 Monitor.
  carol: { id: 'e2e-carol-000000000003', email: 'carol@example.invalid', name: 'Carol', role: 'admin', v: 1 },
};
let server, teamControl, backend, temp, env;
const logs = [];

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

test.beforeAll(async () => {
  const repo = process.env.AIONE_MONITOR_REPO;
  if (!repo) throw new Error('Set AIONE_MONITOR_REPO to the fileHostingService checkout. See test/monitor-sso-e2e/README.md.');
  temp = await mkdtemp(join(tmpdir(), 'aione-sso-e2e-'));
  const pair = generateKeyPairSync('ed25519');
  await writeFile(join(temp, 'e2e-key.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }));
  const store = memoryStore();
  for (const person of Object.values(people)) await saveUser(store, person);
  env = { STORE: store, SESSION_SECRET: 'isolated-e2e-session-secret', ALLOWED_ORIGIN: DASHBOARD,
    MONITOR_SIGNING_KEY: JSON.stringify({ ...pair.privateKey.export({ format: 'jwk' }), kid: 'e2e-key' }) };

  // The Monitor redeems one-time codes server to server, so the redeem route is served here on loopback
  // with the real Team Control handler. The browser never sees this route.
  teamControl = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/sso/monitor/redeem') {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    const reply = await handler.fetch(new Request(PROXY + req.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }), env);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(await reply.text());
  });
  await new Promise(resolveListen => teamControl.listen(0, '127.0.0.1', resolveListen));
  const teamControlUrl = 'http://127.0.0.1:' + teamControl.address().port;

  server = spawn(process.env.AIONE_TEST_PYTHON || 'python', ['-u', fileURLToPath(new URL('./monitor_server.py', import.meta.url)),
    '--repo', resolve(repo), '--keys', temp, '--team-control', teamControlUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', chunk => logs.push(chunk.toString()));
  backend = await new Promise((resolvePort, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Monitor test server did not start. ' + logs.join(''))), 15000);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => { clearTimeout(timer); reject(new Error('Monitor test server exited (' + code + '). ' + logs.join(''))); });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      try { const info = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolvePort('http://127.0.0.1:' + info.port); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const ended = new Promise(resolveExit => server.once('exit', resolveExit));
    server.kill();
    await ended;
  }
  if (teamControl) await new Promise(resolveClose => teamControl.close(resolveClose));
  if (temp) {
    if (!resolve(temp).startsWith(resolve(tmpdir()) + sep) || !basename(temp).startsWith('aione-sso-e2e-')) throw new Error('Unexpected test key directory');
    await rm(temp, { recursive: true, force: true });
  }
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  expect(page.__ssoUnexpected || []).toEqual([]);
});

// The dashboard opens AI1 Monitor in a new tab. These tests check the sign-in exchange, not tabs, and their fake
// servers are set up on this page, so the link is followed in this same tab.
async function clickMonitorLink(page) {
  const link = page.locator('#ai1-monitor-link');
  await link.evaluate(a => a.removeAttribute('target'));
  await link.click();
}

async function setup(page, request, { person = 'alice' } = {}) {
  const requests = [], codes = [], unexpected = [];
  page.__ssoUnexpected = unexpected;
  const sessionFor = async name => ({ ...people[name], ...(await makeToken(env, people[name].email, Date.now(), 1)) });
  const session = await sessionFor(person);
  // The dashboard keeps the Team Control session it was given. A test can replace it before clicking the Monitor link.
  await page.addInitScript(session => {
    if (location.origin === 'https://dashboard.ai1.host' && window === window.parent && !localStorage.getItem('aione-session')) {
      localStorage.setItem('aione-session', JSON.stringify(session));
      localStorage.setItem('aion.notify', '0');
    }
  }, session);
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push(req.url());
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.origin === DASHBOARD) {
      const r = await request.get('http://127.0.0.1:4173' + url.pathname + url.search, { maxRedirects: 0 });
      return route.fulfill({ response: r });
    }
    if (url.origin === MONITOR) {
      const headers = await req.allHeaders();
      delete headers.host;
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
      // Do not let the loopback API client's cookie jar substitute for browser cookies.
      headers.cookie ||= '';
      // Playwright intercepts before Chromium adds Fetch Metadata headers. Reconstruct them from the real frame.
      headers['sec-fetch-dest'] = req.isNavigationRequest() ? (req.frame().parentFrame() ? 'iframe' : 'document') : 'empty';
      if (req.method() === 'POST' && !headers.origin) headers.origin = new URL(req.frame().url()).origin;
      const r = await request.fetch(backend + url.pathname + url.search, { method: req.method(), headers, data: req.postData() ?? undefined, maxRedirects: 0 });
      // HTTP redirects from a routed response bypass page.route in Chromium. A local meta-navigation
      // keeps the browser on the actual entry URL while ensuring the next request is intercepted too.
      if ([301, 302, 303, 307, 308].includes(r.status())) {
        const destination = new URL(r.headers().location, MONITOR);
        if (destination.origin !== MONITOR && destination.origin !== DASHBOARD) throw new Error('Unexpected Monitor redirect origin');
        const h = r.headers(); delete h.location; delete h['content-length'];
        h['content-type'] = 'text/html';
        return route.fulfill({ status: 200, headers: h, body: '<!doctype html><meta http-equiv="refresh" content="0;url=' + destination.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '">' });
      }
      try {
        return await route.fulfill({ status: r.status(), headers: r.headers(), body: await r.body() });
      } catch (error) {
        // A 401 in another parallel read may already have navigated the frame and cancelled this route.
        if (!String(error).includes('Route is already handled')) throw error;
      }
    }
    if (url.origin === PROXY) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': DASHBOARD, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
      if (url.pathname === '/sso/monitor/code' || url.pathname === '/logout') {
        const r = await handler.fetch(new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), ...(req.postData() ? { body: req.postData() } : {}) }), env);
        const body = await r.text();
        if (url.pathname === '/sso/monitor/code' && r.ok) codes.push(body);
        return route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body });
      }
      // Ticket data is unrelated to SSO and never calls a production backend.
      const fixture = url.pathname === '/config' ? { role: 'admin', email: people[person].email, people: {}, devs: [], accounts: true, odoo: false, github: false, mail: false, ai: { enabled: false } }
        : url.pathname === '/jira/search' ? { issues: [], isLast: true }
        : url.pathname === '/internal' ? { tickets: [] }
        : url.pathname === '/date-requests' ? { requests: [] }
        : url.pathname === '/inbox' ? { items: [], readTickets: [] }
        : url.pathname === '/integrations' ? { keys: [] }
        : url.pathname === '/clients' ? { revision: 1, entries: [] }
        : null;
      if (fixture) return route.fulfill({ json: fixture, headers: { 'Access-Control-Allow-Origin': DASHBOARD } });
    }
    unexpected.push(req.url());
    return route.abort().catch(error => { if (!String(error).includes('Route is already handled')) throw error; });
  });
  const open = async () => {
    await page.goto(DASHBOARD + '/dashboard.html');
    await clickMonitorLink(page);
  };
  return { open, requests, codes, sessionFor };
}

// Replaces the Team Control session the dashboard uses, as if another person had signed in to Team Control.
async function useSessionFor(page, sessionFor, name) {
  const session = await sessionFor(name);
  await page.goto(DASHBOARD + '/dashboard.html');
  await page.evaluate(value => localStorage.setItem('aione-session', value), JSON.stringify(session));
}

async function waitForMonitorHome(page) {
  await page.waitForURL(url => url.origin === MONITOR && !url.pathname.startsWith('/auth/'), { timeout: 20000 });
}

// What the Monitor's own session endpoint says about this browser. 401 means no one is signed in.
function monitorSession(page) {
  return page.evaluate(async () => {
    const reply = await fetch('/api/session', { credentials: 'same-origin' });
    return { status: reply.status, body: reply.status === 200 ? await reply.json() : null };
  });
}

test('Alice signs in to AI1 Monitor through a same-tab redirect, and no token reaches the page', async ({ page, request }) => {
  const s = await setup(page, request, { person: 'alice' });
  await s.open();
  await waitForMonitorHome(page);

  const session = await monitorSession(page);
  expect(session.status).toBe(200);
  expect(session.body.user).toMatchObject({ name: 'Alice', auth_provider: 'native' });

  // The browser goes dashboard, then the Monitor callback with a one-time code and the state. Nothing JWT-shaped is in a URL,
  // in the code response, or in the Monitor's storage.
  expect(s.requests.some(url => url.startsWith(MONITOR + '/auth/aione/callback?code='))).toBe(true);
  expect(s.requests.join('\n')).not.toMatch(/eyJ/);
  expect(s.codes).toHaveLength(1);
  expect(s.codes[0]).not.toMatch(/eyJ/);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toMatch(/eyJ/);
});

test('Bob signs in on a browser where Alice is still signed in to AI1 Monitor, and Bob replaces her', async ({ page, request }) => {
  const s = await setup(page, request, { person: 'alice' });
  await s.open();
  await waitForMonitorHome(page);
  expect((await monitorSession(page)).body.user.name).toBe('Alice');

  await useSessionFor(page, s.sessionFor, 'bob');
  await clickMonitorLink(page);
  await waitForMonitorHome(page);
  expect((await monitorSession(page)).body.user.name).toBe('Bob');
});

test('a person with no AION link is refused, and the earlier Monitor session does not stay signed in', async ({ page, request }) => {
  const s = await setup(page, request, { person: 'alice' });
  await s.open();
  await waitForMonitorHome(page);
  expect((await monitorSession(page)).status).toBe(200);

  await useSessionFor(page, s.sessionFor, 'carol');
  await clickMonitorLink(page);
  await expect(page.locator('body')).toContainText('This account cannot use AI1 Monitor.');
  expect((await monitorSession(page)).status).toBe(401);
});

test('a sign-in callback that is used again is refused and the existing Monitor session stays signed in', async ({ page, request }) => {
  const s = await setup(page, request, { person: 'alice' });
  await s.open();
  await waitForMonitorHome(page);
  expect((await monitorSession(page)).body.user.name).toBe('Alice');

  // The first use consumed the state cookie, so the same callback link no longer matches this browser.
  const callback = s.requests.find(url => url.startsWith(MONITOR + '/auth/aione/callback?code='));
  expect(callback).toBeTruthy();
  await page.goto(callback);
  await expect(page.locator('body')).toContainText("AION sign-in didn't match this browser");
  // The rejected callback changes nothing: the original identity is still the one signed in.
  expect((await monitorSession(page)).body.user.name).toBe('Alice');
});
