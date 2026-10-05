// End-to-end test of the built extension (.output/chrome-mv3) in Chromium:
// a fresh NyaPassword server, an account created through the extension,
// autofill through the inline menu, the save/update prompt, items marked
// "使用前需要验证" (reprompt), and a passkey registered and used on a test
// relying party (signature verified by the page).
//
//   npm run build && node tests/e2e.mjs
//   NPW_SERVER_BIN=<path to nyapassword-server> to use another server build.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ext = path.join(root, '.output', 'chrome-mv3');
const pages = path.resolve(root, '..', 'common', 'autofill', 'pages');
const exeName = process.platform === 'win32' ? 'nyapassword-server.exe' : 'nyapassword-server';
const serverBin = process.env.NPW_SERVER_BIN ?? path.resolve(root, '..', 'target', 'debug', exeName);
// free ports, so parallel runs (or another server on the machine) don't collide
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const SERVER_PORT = await freePort();
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
const FIXTURE_PORT = await freePort();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npw-e2e-'));
const exe = path.join(tmp, exeName);
fs.copyFileSync(serverBin, exe);
const server = spawn(exe, ['--data', path.join(tmp, 'data')], { env: { ...process.env, NYAPASSWORD_LISTEN: `127.0.0.1:${SERVER_PORT}`, NYAPASSWORD_LOG: 'warn' }, stdio: 'inherit' });
const fixture = http
  .createServer((req, res) => {
    const file = path.join(pages, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(pages) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  })
  .listen(FIXTURE_PORT, '127.0.0.1');

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
  if (process.env.NPW_E2E_DEBUG) sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));

  // ---- account through the extension (the vault page talks to the service worker)
  const vaultPage = await ctx.newPage();
  await vaultPage.goto(`chrome-extension://${id}/vault.html`);
  const rpc = async (m, ...a) => {
    const r = await vaultPage.evaluate(([m, a]) => chrome.runtime.sendMessage({ t: 'call', m, a }), [m, a]);
    if (!r?.ok) throw new Error(`${m}: ${r?.e?.message}`);
    return r.v;
  };
  // headless Chromium reports the screen as locked; the extension would lock right away
  await vaultPage.evaluate(() => chrome.storage.local.set({ lockOnScreenLock: false }));
  const kit = await rpc('register', SERVER, 'e2e@example.com', 'e2e test password 2026', null);
  check('register through the extension', /^A1-/.test(kit.secret_key));
  const vault = (await rpc('vaults'))[0].id;
  const item = await rpc('newItem', 'login');
  item.title = 'Fixture site';
  item.fields.find((f) => f.id === 'username').value = 'alice@example.com';
  item.fields.find((f) => f.id === 'password').value = 'old-password-1';
  item.fields.find((f) => f.id === 'otp').value = 'JBSWY3DPEHPK3PXP';
  item.urls = [{ id: 'u1', url: `http://127.0.0.1:${FIXTURE_PORT}`, match: 'domain' }];
  const itemId = await rpc('saveItem', vault, null, item);

  // ---- autofill through the inline menu
  const site = await ctx.newPage();
  if (process.env.NPW_E2E_DEBUG) {
    site.on('console', (m) => console.log('[page]', m.type(), m.text()));
  }
  await site.goto(`http://127.0.0.1:${FIXTURE_PORT}/login.html`);
  await site.waitForTimeout(500);
  await site.click('#account');
  const inline = await waitFor(async () => site.frames().find((f) => f.url().includes('/inline.html'))).catch(async (e) => {
    console.log('frames:', site.frames().map((f) => f.url()));
    console.log('sw errors:', await sw.evaluate(() => String(globalThis.__npwErrors ?? 'none')).catch((x) => String(x)));
    throw e;
  });
  await inline.waitForSelector('button.opt');
  await site.waitForTimeout(400); // the menu ignores clicks right after it opens (anti-clickjacking)
  await inline.click('button.opt');
  await waitFor(async () => (await site.inputValue('#pwd')) === 'old-password-1');
  check('inline menu fills username and password', (await site.inputValue('#account')) === 'alice@example.com' && (await site.inputValue('#pwd')) === 'old-password-1');
  check('one-time code filled into the 2FA field', /^\d{6}$/.test(await site.inputValue('#code')));

  // ---- a changed password is offered as an update
  await site.fill('#pwd', 'new-password-2');
  await site.click('#go');
  const prompt = await waitFor(async () => site.frames().find((f) => f.url().includes('/prompt.html')));
  await prompt.waitForSelector('text=更新');
  await prompt.click('button.primary');
  const updated = await waitFor(async () => {
    const v = await rpc('item', vault, itemId);
    return v.content.fields.find((f) => f.id === 'password').value === 'new-password-2' ? v : undefined;
  });
  check('save prompt updates the password', !!updated);
  check('old password kept in history', updated.content.history?.some((h) => h.value === 'old-password-1'));

  // ---- "使用前需要验证" (reprompt): the inline menu asks for the master password, the shortcut skips the item
  const PASSWORD = 'e2e test password 2026';
  const login = async (title, user, pw, reprompt) => {
    const it = await rpc('newItem', 'login');
    it.title = title;
    it.fields.find((f) => f.id === 'username').value = user;
    it.fields.find((f) => f.id === 'password').value = pw;
    it.urls = [{ id: 'u1', url: `http://localhost:${FIXTURE_PORT}`, match: 'domain' }];
    if (reprompt) it.reprompt = true;
    return rpc('saveItem', vault, null, it);
  };
  await login('Open login', 'carol@example.com', 'open-pass-1', false);
  await new Promise((r) => setTimeout(r, 30)); // newer: the guarded login is the first match
  const guardedId = await login('Guarded login', 'bob@example.com', 'guarded-pass-1', true);
  check('reprompt flag on the item view', (await rpc('listItems', {})).find((i) => i.item_id === guardedId)?.reprompt === true);

  const gp = await ctx.newPage();
  await gp.goto(`http://localhost:${FIXTURE_PORT}/login.html`);
  await gp.waitForTimeout(500);
  await gp.click('#account');
  const gm = await waitFor(async () => gp.frames().find((f) => f.url().includes('/inline.html') && !f.isDetached()));
  const guardedOpt = 'button.opt:has-text("Guarded login")';
  await gm.waitForSelector(guardedOpt);
  const gn = new URL(gm.url()).searchParams.get('n');
  check('inline menu marks the reprompt login', (await gm.$(`${guardedOpt} .lock`)) !== null);
  await gp.waitForTimeout(400);
  await gm.click(guardedOpt);
  await gm.waitForSelector('form.verify input[type=password]');
  await gp.waitForTimeout(500);
  check('picking a reprompt login asks for the master password', (await gp.inputValue('#pwd')) === '' && (await gp.inputValue('#account')) === '');
  // the service worker enforces it: a fill request without the password is refused
  const direct = await vaultPage.evaluate(([n, v, i]) => chrome.runtime.sendMessage({ t: 'ctx:fill', n, vault_id: v, item_id: i }), [gn, vault, guardedId]);
  check('service worker refuses to fill without verification', direct?.ok === false && direct.e?.code === 'reprompt', JSON.stringify(direct?.e));
  await gm.fill('form.verify input[type=password]', 'not the password');
  await gm.click('form.verify button:not(.back)');
  await gm.waitForSelector('.err:has-text("主密码不正确")', { timeout: 20000 });
  await gp.waitForTimeout(500);
  check('a wrong password does not fill', (await gp.inputValue('#pwd')) === '' && (await gp.inputValue('#account')) === '');
  await gm.fill('form.verify input[type=password]', PASSWORD);
  await gm.click('form.verify button:not(.back)');
  const guardedFilled = await waitFor(async () => ((await gp.inputValue('#pwd')) === 'guarded-pass-1' ? true : undefined), 20000).catch(() => false);
  check('the right password fills the reprompt login', guardedFilled && (await gp.inputValue('#account')) === 'bob@example.com');
  const again = await vaultPage.evaluate(([n, v, i]) => chrome.runtime.sendMessage({ t: 'ctx:fill', n, vault_id: v, item_id: i }), [gn, vault, guardedId]);
  check('a verification fills once', again?.ok === false && again.e?.code === 'reprompt', JSON.stringify(again?.e));

  // the fill shortcut (Ctrl+Shift+L) takes the first match that does not ask: the open login
  // (automated browsers do not deliver extension shortcuts: run its action in the worker)
  const sp = await ctx.newPage();
  await sp.goto(`http://localhost:${FIXTURE_PORT}/login.html`);
  await sp.waitForTimeout(800);
  await sp.bringToFront();
  await sw.evaluate(() => globalThis.npwFillShortcut());
  const viaShortcut = await waitFor(async () => (await sp.inputValue('#pwd')) || undefined, 8000).catch(() => '');
  check('the fill shortcut skips the reprompt login', viaShortcut === 'open-pass-1' && (await sp.inputValue('#account')) === 'carol@example.com', viaShortcut || 'nothing filled');

  // ---- passkeys
  const rp = await ctx.newPage();
  await rp.goto(`http://localhost:${FIXTURE_PORT}/passkey.html`);
  await rp.click('#create');
  const p1 = await waitFor(async () => rp.frames().find((f) => f.url().includes('/prompt.html')));
  await p1.waitForSelector('text=保存通行密钥');
  await p1.click('button.primary');
  const created = await waitFor(async () => {
    const t = await rp.textContent('#out');
    return t && t.length ? t : undefined;
  });
  check('passkey registered on the RP', created.startsWith('created:') && created.includes('alg:-7'), created);
  await rp.click('#get');
  const p2 = await waitFor(async () => rp.frames().find((f) => f.url().includes('/prompt.html') && !f.isDetached()));
  await p2.waitForSelector('button.opt');
  await p2.click('button.opt');
  const asserted = await waitFor(async () => {
    const t = await rp.textContent('#out');
    return t && !t.startsWith('created:') ? t : undefined;
  });
  check('passkey sign-in verified by the RP', asserted.startsWith('VERIFIED'), asserted);

  // like Google's sign-in challenge: the call comes from a hidden about:blank frame;
  // the prompt must still show, in the top frame
  await rp.evaluate(() => (document.getElementById('out').textContent = ''));
  await rp.click('#get-blank');
  const pBlank = await waitFor(async () => rp.frames().find((f) => f.url().includes('/prompt.html') && !f.isDetached() && f.parentFrame() === rp.mainFrame()), 8000).catch(() => null);
  if (pBlank) {
    await pBlank.waitForSelector('button.opt');
    await rp.waitForTimeout(400);
    await pBlank.click('button.opt');
  }
  const assertedBlank = await waitFor(async () => (await rp.textContent('#out')) || undefined, 10000).catch(() => '');
  check('passkey from a hidden about:blank frame: prompt in the top frame, RP verifies', !!pBlank && assertedBlank.startsWith('VERIFIED'), assertedBlank || 'no prompt');
  const withPasskey = (await rpc('listItems', {})).find((i) => i.passkeys > 0);
  check('passkey stored in the vault', !!withPasskey, withPasskey?.title);

  // a passkey of a reprompt item: the prompt asks for the master password before signing
  const pkItem = await rpc('item', withPasskey.vault_id, withPasskey.item_id);
  pkItem.content.reprompt = true;
  await rpc('saveItem', withPasskey.vault_id, withPasskey.item_id, pkItem.content);
  await rp.evaluate(() => (document.getElementById('out').textContent = ''));
  await rp.click('#get');
  const p3 = await waitFor(async () => rp.frames().find((f) => f !== p2 && f.url().includes('/prompt.html') && !f.isDetached()));
  await p3.waitForSelector('button.opt');
  await p3.click('button.opt');
  await p3.waitForSelector('input[type=password]');
  await rp.waitForTimeout(300);
  check('a reprompt passkey asks for the master password', !(await rp.textContent('#out')));
  await p3.fill('input[type=password]', 'not the password');
  await p3.click('form button.primary');
  await p3.waitForSelector('.err:has-text("主密码不正确")', { timeout: 20000 });
  check('a wrong password does not sign', !(await rp.textContent('#out')));
  await p3.fill('input[type=password]', PASSWORD);
  await p3.click('form button.primary');
  const asserted2 = await waitFor(async () => (await rp.textContent('#out')) || undefined, 20000).catch(() => '');
  check('the right password signs with the reprompt passkey', asserted2.startsWith('VERIFIED'), asserted2);

  // ---- bank card and shipping address (not bound to a site: picked from the menu)
  const card = await rpc('newItem', 'credit_card');
  card.title = '招商银行信用卡';
  const setF = (c, id, v) => (c.fields.find((f) => f.id === id).value = v);
  setF(card, 'cardholder', 'ZHANG SAN');
  setF(card, 'number', '6225 8800 1122 3344');
  setF(card, 'expiry', '2028-03');
  setF(card, 'cvv', '321');
  await rpc('saveItem', vault, null, card);
  const me = await rpc('newItem', 'identity');
  me.title = '张三（家）';
  setF(me, 'full_name', '张三');
  setF(me, 'phone', '13800000000');
  setF(me, 'address', { province: '广东省', city: '深圳市', district: '南山区', street: '科技园路 1 号', postal_code: '518000' });
  await rpc('saveItem', vault, null, me);

  const shop = await ctx.newPage();
  await shop.goto(`http://127.0.0.1:${FIXTURE_PORT}/checkout.html`);
  await shop.waitForTimeout(500);
  const pickFromMenu = async (selector, title) => {
    await shop.click(selector);
    const menu = await waitFor(async () => shop.frames().find((f) => f.url().includes('/inline.html') && !f.isDetached()));
    await menu.waitForSelector(`button.opt:has-text("${title}")`);
    await shop.waitForTimeout(400);
    await menu.click(`button.opt:has-text("${title}")`);
  };
  await pickFromMenu('#cardno', '招商银行信用卡');
  await waitFor(async () => (await shop.inputValue('#cardno')) !== '');
  const cardVals = await Promise.all(['#cardno', '#holder', '#mm', '#yy', '#cvv'].map((s) => shop.inputValue(s)));
  check('bank card filled (number, holder, month / year selects, CVV)', cardVals.join('|') === '6225880011223344|ZHANG SAN|03|28|321', cardVals.join('|'));
  await shop.waitForTimeout(3200); // right after a fill, focusing a field does not reopen the menu
  await pickFromMenu('#consignee', '张三（家）');
  await waitFor(async () => (await shop.inputValue('#consignee')) !== '');
  const addrVals = await Promise.all(['#consignee', '#mobile', '#province', '#city', '#district', '#detail', '#zip'].map((s) => shop.inputValue(s)));
  check('shipping address filled (province select, city, street)', addrVals.join('|') === '张三|13800000000|44|深圳市|南山区|科技园路 1 号|518000', addrVals.join('|'));

  // ---- optional fill on page load (off by default)
  const plain = await ctx.newPage();
  await plain.goto(`http://127.0.0.1:${FIXTURE_PORT}/login.html`);
  await plain.waitForTimeout(1500);
  const untouched = (await plain.inputValue('#pwd')) === '';
  await vaultPage.evaluate(() => chrome.storage.local.set({ autofillOnLoad: true }));
  await plain.reload();
  const filledOnLoad = await waitFor(async () => ((await plain.inputValue('#pwd')) === 'new-password-2' ? true : undefined), 8000).catch(() => false);
  check('fill on page load: off by default, works when turned on', untouched && filledOnLoad);
  await vaultPage.evaluate(() => chrome.storage.local.set({ autofillOnLoad: false }));

  // ---- a login form of another site embedded in the page: no automatic menu, a warning when asked
  const framed = await ctx.newPage();
  await framed.goto(`http://localhost:${FIXTURE_PORT}/framed.html?src=${encodeURIComponent(`http://127.0.0.1:${FIXTURE_PORT}/login.html`)}`);
  const inner = await waitFor(async () => framed.frames().find((f) => f.url().includes('/login.html')));
  await inner.waitForSelector('#account');
  await framed.waitForTimeout(800);
  await inner.click('#account');
  await framed.waitForTimeout(1500);
  const autoOpened = framed.frames().some((f) => f.url().includes('/inline.html'));
  const box = await (await inner.$('#account')).boundingBox();
  await framed.mouse.click(box.x + box.width - 15, box.y + box.height / 2); // the NyaPassword button in the field
  const warnMenu = await waitFor(async () => framed.frames().find((f) => f.url().includes('/inline.html') && !f.isDetached()), 8000).catch(() => null);
  const warned = warnMenu ? await warnMenu.waitForSelector('.warn', { timeout: 5000 }).then(() => true).catch(() => false) : false;
  check('cross-site frame: menu not opened by itself, warning when opened', !autoOpened && warned, `auto=${autoOpened} menu=${!!warnMenu} warned=${warned}`);

  // ---- sync reached the server
  const report = await rpc('sync');
  const dev = await rpc('devices');
  check('synced with the server', report && dev.length === 1);
} catch (e) {
  check('e2e run', false, String(e?.stack ?? e));
} finally {
  await ctx?.close().catch(() => {});
  server.kill();
  fixture.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
