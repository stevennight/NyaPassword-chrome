// Renders the Chrome Web Store / Edge Add-ons images into store/:
// screenshots (1280x800, one set per listing language), the small promo
// tile (440x280), the store icon (128x128) and the Edge logo (300x300).
// The UI shots come from the built extension (.output/chrome-mv3) running
// against a fresh local server with demo data, as in tests/e2e.mjs.
//
//   npm run build && node scripts/store-assets.mjs
//   NPW_SERVER_BIN=<path to nyapassword-server> to use another server build.

import { chromium } from 'playwright';
import { Resvg } from '@resvg/resvg-js';
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
const out = path.join(root, 'store');
const raw = path.join(os.tmpdir(), 'npw-store-raw');
const exeName = process.platform === 'win32' ? 'nyapassword-server.exe' : 'nyapassword-server';
const serverBin = process.env.NPW_SERVER_BIN ?? path.resolve(root, '..', 'target', 'debug', exeName);
const logoSvg = fs.readFileSync(path.resolve(root, '..', 'common', 'web', 'public', 'favicon.svg'), 'utf8');
const logoUri = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;
fs.mkdirSync(raw, { recursive: true });
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function waitFor(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

// ---------------------------------------------------------------- demo site

// A made-up shop at shop.example.com (mapped to the local fixture server).
const DEMO_LOGIN = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录 · 喵铺</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:#1f2430;background:linear-gradient(135deg,#fff4ec,#ffe3d3);min-height:100vh}
header{display:flex;align-items:center;gap:10px;padding:18px 40px;font-weight:700;font-size:20px;color:#e2562b}
header span{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#e2562b;color:#fff;font-size:18px}
main{display:grid;place-items:center;padding-top:40px}
form{background:#fff;width:380px;padding:30px 32px 26px;border-radius:16px;box-shadow:0 12px 40px rgba(226,86,43,.15);display:flex;flex-direction:column;gap:14px}
h1{margin:0 0 4px;font-size:22px}p{margin:0;color:#7a7f8c;font-size:13px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#555}
input{font:inherit;padding:10px 12px;border:1px solid #dcdfe6;border-radius:9px;outline:none}input:focus{border-color:#e2562b}
button{font:inherit;margin-top:6px;padding:11px;border:0;border-radius:9px;background:#e2562b;color:#fff;font-weight:600}
</style></head><body><header><span>喵</span>喵铺</header><main>
<form id="f" onsubmit="event.preventDefault()"><h1>欢迎回来</h1><p>登录后查看订单和收藏</p>
<label>账号<input id="account" name="account" placeholder="手机号 / 邮箱"></label>
<label>密码<input id="pwd" name="pwd" type="password" placeholder="请输入密码"></label>
<button id="go" type="submit">登录</button></form></main></body></html>`;

// ---------------------------------------------------------------- capture

async function capture() {
  const SERVER_PORT = await freePort();
  const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
  const SITE_PORT = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npw-store-'));
  const exe = path.join(tmp, exeName);
  fs.copyFileSync(serverBin, exe);
  const server = spawn(exe, ['--data', path.join(tmp, 'data')], { env: { ...process.env, NYAPASSWORD_LISTEN: `127.0.0.1:${SERVER_PORT}`, NYAPASSWORD_LOG: 'warn' }, stdio: 'inherit' });
  const site = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DEMO_LOGIN)).listen(SITE_PORT, '127.0.0.1');
  let ctx;
  try {
    await waitFor(() => fetch(`${SERVER}/v1/health`).then((r) => r.ok));
    ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      channel: 'chromium',
      headless: true,
      deviceScaleFactor: 2,
      locale: 'zh-CN',
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--host-resolver-rules=MAP shop.example.com:80 127.0.0.1:${SITE_PORT}`],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const id = new URL(sw.url()).host;

    // ---- demo vault
    const vaultPage = await ctx.newPage();
    await vaultPage.setViewportSize({ width: 1200, height: 680 }); // wider than 1100: the sidebar shows
    await vaultPage.goto(`chrome-extension://${id}/vault.html`);
    const rpc = async (m, ...a) => {
      const r = await vaultPage.evaluate(([m, a]) => chrome.runtime.sendMessage({ t: 'call', m, a }), [m, a]);
      if (!r?.ok) throw new Error(`${m}: ${r?.e?.message}`);
      return r.v;
    };
    await vaultPage.evaluate(() => chrome.storage.local.set({ lockOnScreenLock: false }));
    await rpc('register', SERVER, 'demo@example.com', 'store demo password 2026', null);
    const vault = (await rpc('vaults'))[0].id;
    const setF = (it, fid, v) => (it.fields.find((f) => f.id === fid).value = v);
    const login = async (title, user, pw, url, extra = {}) => {
      const it = await rpc('newItem', 'login');
      it.title = title;
      setF(it, 'username', user);
      setF(it, 'password', pw);
      if (extra.otp) setF(it, 'otp', extra.otp);
      it.urls = [{ id: 'u1', url, match: 'domain' }];
      if (extra.tags) it.tags = extra.tags;
      return rpc('saveItem', vault, null, it);
    };
    await login('喵铺', 'xiaoming@example.com', 'k7#Qv9!mZr2$Lp', 'http://shop.example.com', { otp: 'JBSWY3DPEHPK3PXP', tags: ['购物'] });
    await login('喵铺（家庭账号）', '138****0000', 'Tq8&wN3@yHs6', 'http://shop.example.com', { tags: ['购物', '家庭'] });
    await login('公司邮箱', 'xiaoming@corp.example.com', 'p4$Xm!8vRt#2', 'https://mail.example.com', { otp: 'JBSWY3DPEHPK3PXP', tags: ['工作'] });
    await login('代码托管', 'xiaoming', 'Hz5!cW9&pQ2#', 'https://git.example.com', { tags: ['工作'] });
    await login('家里的 NAS', 'admin', 'Nas-2026-Vq7!', 'https://nas.example.net', { tags: ['家庭'] });
    await login('云服务器控制台', 'ops@example.com', 'Rk3#vT8!wL5$', 'https://console.example.org', { tags: ['工作'] });
    const card = await rpc('newItem', 'credit_card');
    card.title = '工资卡';
    setF(card, 'cardholder', 'XIAO MING');
    setF(card, 'number', '6222 0000 1234 5678');
    setF(card, 'expiry', '2029-06');
    setF(card, 'cvv', '123');
    await rpc('saveItem', vault, null, card);
    const note = await rpc('newItem', 'secure_note').catch(() => null);
    if (note) {
      note.title = 'Wi-Fi 密码';
      await rpc('saveItem', vault, null, note).catch(() => null);
    }

    // ---- inline menu on the shop login page
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto('http://shop.example.com/');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(raw, 'site.png') });
    await page.click('#account');
    const inline = await waitFor(async () => page.frames().find((f) => f.url().includes('/inline.html')));
    await inline.waitForSelector('button.opt');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(raw, 'inline.png') });

    // ---- save prompt after signing in with a new password
    await page.keyboard.press('Escape');
    await page.fill('#account', 'xiaoming@example.com');
    await page.fill('#pwd', 'N3w!pass-2026');
    await page.click('#go');
    const prompt = await waitFor(async () => page.frames().find((f) => f.url().includes('/prompt.html')));
    await prompt.waitForSelector('button.primary');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(raw, 'prompt.png') });

    // ---- toolbar popup (as a tab: it would see itself as the current tab)
    const pop = await ctx.newPage();
    await pop.addInitScript(() => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => {
        const tabs = await q({});
        const shop = tabs.find((t) => t.url?.startsWith('http://shop.example.com'));
        return info?.active && shop ? [shop] : q(info);
      };
    });
    await pop.setViewportSize({ width: 360, height: 600 });
    await pop.goto(`chrome-extension://${id}/popup.html`);
    await pop.waitForTimeout(1200);
    await pop.locator('.pop').screenshot({ path: path.join(raw, 'popup.png') });

    // ---- full vault page
    await vaultPage.reload();
    await vaultPage.waitForTimeout(1500);
    await vaultPage.getByText('公司邮箱').first().click().catch(() => {});
    await vaultPage.waitForTimeout(800);
    // show the server as a real deployment would, not the local test address
    await vaultPage.evaluate((host) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode()); ) if (n.nodeValue.includes(host)) n.nodeValue = n.nodeValue.replace(host, 'vault.example.com');
    }, `127.0.0.1:${SERVER_PORT}`);
    await vaultPage.screenshot({ path: path.join(raw, 'vault.png') });
  } finally {
    await ctx?.close().catch(() => {});
    server.kill();
    site.close();
  }
}

// ---------------------------------------------------------------- compose

const CAPTIONS = {
  zh: [
    ['点一下，自动填写', '在登录框旁选择账号，用户名、密码和一次性密码一次填好。'],
    ['新密码自动保存', '登录或修改密码后提示保存，旧密码留在历史里，随时找回。'],
    ['本站账号一目了然', '工具栏弹窗列出此网站的账号，支持拼音搜索和生成密码。'],
    ['完整密码库，端到端加密', '登录、一次性密码、银行卡、笔记……在本机加密后才同步到你自己的服务器。'],
  ],
  en: [
    ['Fill logins in one click', 'Pick an account right in the login field: username, password and one-time code, filled together.'],
    ['Saves new passwords for you', 'Offers to save or update after you sign in. Old passwords stay in the history.'],
    ['Everything for this site', "The toolbar popup lists this site's logins, searches the whole vault and generates passwords."],
    ['Your vault, end-to-end encrypted', 'Logins, one-time codes, cards and notes, encrypted on your device before they sync to your own server.'],
  ],
};
const TAGLINE = { zh: '自建 · 端到端加密的密码管理器', en: 'Self-hosted, end-to-end encrypted password manager' };

const img = (name) => `data:image/png;base64,${fs.readFileSync(path.join(raw, name)).toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = '"Microsoft YaHei UI","PingFang SC","Segoe UI",system-ui,sans-serif';

/** A browser window around a page shot; `w` is the page width in CSS px. */
function browser(url, w, body) {
  return `<div class="win" style="width:${w}px"><div class="bar"><i></i><i></i><i></i><div class="url">${esc(url)}</div><img class="tb" src="${logoUri}"></div><div class="page">${body}</div></div>`;
}

function shot(lang, i) {
  const [title, sub] = CAPTIONS[lang][i];
  const S = 0.84; // page shots are 1000x640 CSS px
  const pageW = 1000 * S;
  let win;
  if (i === 0) win = browser('shop.example.com', pageW, `<img src="${img('inline.png')}" style="width:${pageW}px">`);
  if (i === 1) win = browser('shop.example.com', pageW, `<img src="${img('prompt.png')}" style="width:${pageW}px">`);
  if (i === 2)
    win = browser('shop.example.com', pageW, `<img src="${img('site.png')}" style="width:${pageW}px"><img class="popup" src="${img('popup.png')}" style="width:${360 * S}px">`);
  if (i === 3) {
    // the vault is its own wide page: caption on top, window below
    const w = 1200 * 0.92;
    return `<div class="top"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
      <div class="below">${browser('NyaPassword', w, `<img src="${img('vault.png')}" style="width:${w}px">`)}</div>`;
  }
  return `<div class="side"><img class="logo" src="${logoUri}"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="right">${win}</div>`;
}

const BASE = `*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;overflow:hidden}
body{font-family:${FONT};color:#1b2140;background:linear-gradient(140deg,#eef2ff 0%,#dfe6ff 55%,#cbd6ff 100%);position:relative}
.side{position:absolute;left:56px;top:0;bottom:0;width:300px;display:flex;flex-direction:column;justify-content:center;gap:18px}
.side .logo{width:56px;height:56px}.side h1{font-size:34px;line-height:1.25;font-weight:700}.side p{font-size:19px;line-height:1.6;color:#4a5275}
.right{position:absolute;right:40px;top:0;bottom:0;display:flex;align-items:center}
.top{position:absolute;left:0;right:0;top:34px;text-align:center}.top h1{font-size:34px;font-weight:700}.top p{margin-top:8px;font-size:18px;color:#4a5275}
.below{position:absolute;left:0;right:0;top:142px;display:flex;justify-content:center}
.win{border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 24px 60px rgba(40,60,160,.25),0 0 0 1px rgba(40,60,160,.08)}
.bar{height:38px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#f1f3f8;border-bottom:1px solid #e1e5ee}
.bar i{width:11px;height:11px;border-radius:50%;background:#d5d9e3}.bar i:nth-child(1){background:#ff6058}.bar i:nth-child(2){background:#ffbd2e}.bar i:nth-child(3){background:#28c940}
.url{flex:1;margin:0 14px;height:24px;line-height:24px;border-radius:12px;background:#fff;padding:0 14px;font-size:13px;color:#5b6275}
.tb{width:18px;height:18px}.page{position:relative;line-height:0}.page img{display:block}
.popup{position:absolute;top:0;right:8px;border-radius:0 0 10px 10px;box-shadow:0 12px 32px rgba(0,0,0,.22)}`;

const TILE = (lang) => `<div class="tile"><img src="${logoUri}"><div><b>NyaPassword</b><span>${esc(TAGLINE[lang])}</span></div></div>`;
const TILE_CSS = `*{box-sizing:border-box;margin:0}body{font-family:${FONT};width:440px;height:280px;overflow:hidden;background:linear-gradient(140deg,#4a6ff7,#2c4fd8)}
.tile{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;text-align:center;padding:0 28px}
.tile img{width:88px;height:88px;padding:12px;border-radius:24px;background:#fff}.tile b{display:block;font-size:34px}.tile span{display:block;margin-top:6px;font-size:16px;opacity:.9}`;

async function compose() {
  const browserApp = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browserApp.newPage({ deviceScaleFactor: 1 });
  const render = async (html, css, w, h, file) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
    await page.screenshot({ path: file });
  };
  for (const lang of ['zh', 'en']) {
    for (let i = 0; i < 4; i++) await render(shot(lang, i), BASE, 1280, 800, path.join(out, 'screenshots', `${lang}-${i + 1}.png`));
    await render(TILE(lang), TILE_CSS, 440, 280, path.join(out, `promo-440x280-${lang}.png`));
  }
  await browserApp.close();
  // store icon: 96x96 artwork in 16px of transparent padding; Edge logo 300x300
  const padded = (size, art) => {
    const png = new Resvg(logoSvg, { fitTo: { mode: 'width', value: art } }).render().asPng();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="data:image/png;base64,${png.toString('base64')}" x="${(size - art) / 2}" y="${(size - art) / 2}" width="${art}" height="${art}"/></svg>`;
  };
  fs.writeFileSync(path.join(out, 'icon-128.png'), new Resvg(padded(128, 96)).render().asPng());
  fs.writeFileSync(path.join(out, 'logo-300.png'), new Resvg(padded(300, 260)).render().asPng());
}

if (!process.env.NPW_STORE_SKIP_CAPTURE) await capture();
await compose();
console.log('store images written to', out);
