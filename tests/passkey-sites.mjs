// Passkeys on a real public relying party (webauthn.io): register and sign in
// through the extension, the way a user would. Needs network access; not part
// of CI. Prints the page's and the service worker's console with
// NPW_E2E_DEBUG=1.
//
//   npm run build && node tests/passkey-sites.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, '.output', 'chrome-mv3');
const exeName = process.platform === 'win32' ? 'nyapassword-server.exe' : 'nyapassword-server';
const serverBin = process.env.NPW_SERVER_BIN ?? path.resolve(root, '..', 'target', 'debug', exeName);
const debug = !!process.env.NPW_E2E_DEBUG;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, ms = 20000, step = 150) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

const port = await freePort();
const SERVER = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npw-pk-'));
const exe = path.join(tmp, exeName);
fs.copyFileSync(serverBin, exe);
const server = spawn(exe, ['--data', path.join(tmp, 'data')], { env: { ...process.env, NYAPASSWORD_LISTEN: `127.0.0.1:${port}`, NYAPASSWORD_LOG: 'warn' }, stdio: 'inherit' });

let ctx;
try {
  await waitFor(() => fetch(`${SERVER}/v1/health`).then((r) => r.ok));
  ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  if (debug) sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));

  const vaultPage = await ctx.newPage();
  await vaultPage.goto(`chrome-extension://${id}/vault.html`);
  const rpc = async (m, ...a) => {
    const r = await vaultPage.evaluate(([m, a]) => chrome.runtime.sendMessage({ t: 'call', m, a }), [m, a]);
    if (!r?.ok) throw new Error(`${m}: ${r?.e?.message}`);
    return r.v;
  };
  await vaultPage.evaluate(() => chrome.storage.local.set({ lockOnScreenLock: false }));
  await rpc('register', SERVER, 'pk@example.com', 'passkey sites test 2026', null);

  const rp = await ctx.newPage();
  if (debug) rp.on('console', (m) => console.log('[page]', m.type(), m.text()));
  const user = `npw-test-${Date.now().toString(36)}`;
  await rp.goto('https://webauthn.io/', { waitUntil: 'domcontentloaded' });
  await rp.fill('input[placeholder="example_username"]', user);
  await rp.click('button:has-text("Register")');
  const p1 = await waitFor(async () => rp.frames().find((f) => f.url().includes('/prompt.html') && !f.isDetached()));
  await p1.waitForSelector('text=保存通行密钥');
  await rp.waitForTimeout(400);
  await p1.click('button.primary');
  const registered = await waitFor(async () => /success|成功/i.test(await rp.textContent('body')) || undefined, 20000).catch(() => false);
  check('webauthn.io: register a passkey', !!registered);
  const saved = (await rpc('listItems', {})).find((i) => i.passkeys > 0);
  check('passkey stored in the vault', !!saved, saved?.title);

  await rp.reload({ waitUntil: 'domcontentloaded' });
  await rp.fill('input[placeholder="example_username"]', user);
  await rp.click('button:has-text("Authenticate")');
  const p2 = await waitFor(async () => rp.frames().find((f) => f.url().includes('/prompt.html') && !f.isDetached()));
  await p2.waitForSelector('button.opt');
  await rp.waitForTimeout(400);
  await p2.click('button.opt');
  const signedIn = await waitFor(async () => /logged in|you're in|success/i.test(await rp.textContent('body')) || undefined, 20000).catch(() => false);
  check('webauthn.io: sign in with the passkey', !!signedIn, signedIn ? '' : (await rp.textContent('body')).replace(/\s+/g, ' ').slice(0, 300));
} catch (e) {
  check('run', false, String(e?.stack ?? e));
} finally {
  await ctx?.close().catch(() => {});
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
