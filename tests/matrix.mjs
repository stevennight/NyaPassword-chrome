// Login-form detection on real sites (autofill test matrix, design doc §11).
// Opens each public login page in Chromium, runs the extension's form
// detection (src/lib/forms.ts) in every frame and prints what it found.
// Nothing is typed or submitted.
//
//   node tests/matrix.mjs [--json out.json]

import { chromium } from 'playwright';
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [site, url, what a correct detection looks like]
// expect: 'up' username + password, 'u' username step (multi-step login), 'p' password only
const SITES = [
  ['GitHub', 'https://github.com/login', 'up'],
  ['Google', 'https://accounts.google.com/signin', 'u'],
  ['Microsoft', 'https://login.live.com/', 'u'],
  ['Apple ID', 'https://account.apple.com/sign-in', 'u'],
  ['淘宝', 'https://login.taobao.com/', 'up'],
  ['京东', 'https://passport.jd.com/new/login.aspx', 'up'],
  ['支付宝', 'https://auth.alipay.com/login/index.htm', 'up'],
  ['微博', 'https://passport.weibo.com/sso/signin', 'up'],
  ['哔哩哔哩', 'https://passport.bilibili.com/login', 'up'],
  ['知乎', 'https://www.zhihu.com/signin', 'up'],
  ['网易邮箱', 'https://mail.163.com/', 'up'],
  ['QQ 邮箱', 'https://mail.qq.com/', 'up'],
  ['阿里云', 'https://account.aliyun.com/login/login.htm', 'up'],
  ['阿里云 RAM', 'https://signin.aliyun.com/login.htm', 'u'],
  ['腾讯云', 'https://cloud.tencent.com/login', 'up'],
  ['GitLab', 'https://gitlab.com/users/sign_in', 'up'],
  ['Cloudflare', 'https://dash.cloudflare.com/login', 'up'],
];

const bundle = await build({
  configFile: false,
  logLevel: 'silent',
  build: { write: false, minify: false, lib: { entry: path.join(root, 'src/lib/forms.ts'), name: 'npwForms', formats: ['iife'], fileName: () => 'forms.js' } },
});
const code = bundle[0]?.output?.[0]?.code ?? bundle.output[0].code;

const out = [];
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
// pages that open on a QR code / SMS tab: the password tab is tried once
// (QQ and e-mail tabs first lead to a page that has the password tab)
const PASSWORD_TABS = ['密码登录', '账号密码登录', '帐号密码登录', '账密登录', '使用密码登录', '账号登录', '帐号登录', '密码登入', 'QQ登录', '邮箱登录'];

async function detect(page) {
  const found = [];
  for (const f of page.frames()) {
    const r = await f
      .evaluate(`(() => { ${code}; return npwForms.findForms(document).map((x) => ({ u: !!x.username, p: !!x.password, o: !!x.otp, n: x.isNew })); })()`)
      .catch((e) => (process.env.NPW_MATRIX_DEBUG && console.log('   eval error:', String(e).slice(0, 300)), []));
    for (const x of r) found.push({ frame: f === page.mainFrame() ? 'main' : new URL(f.url()).host, ...x });
  }
  return found;
}

const good = (found, expect) => found.some((x) => !x.n && (expect === 'up' ? x.u && x.p : expect === 'u' ? x.u : x.p));

for (const [site, url, expect] of SITES) {
  const page = await ctx.newPage();
  let found = [];
  let error = '';
  let switched = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
    found = await detect(page);
    const clicked = [];
    for (let round = 0; round < 2 && !good(found, expect); round++) {
      let hit = '';
      outer: for (const f of page.frames()) {
        for (const t of PASSWORD_TABS) {
          if (clicked.includes(t)) continue;
          const all = f.getByText(t, { exact: true });
          const n = await all.count().catch(() => 0);
          for (let i = 0; i < n; i++) {
            const el = all.nth(i);
            if (!(await el.isVisible().catch(() => false))) continue;
            await el.click({ timeout: 3000 }).catch(() => {});
            hit = t;
            break outer;
          }
        }
      }
      if (!hit) break;
      clicked.push(hit);
      await page.waitForTimeout(2500);
      found = await detect(page);
    }
    switched = clicked.join(' → ');
  } catch (e) {
    error = String(e.message ?? e).split('\n')[0];
  }
  const title = await page.title().catch(() => '');
  // bot checks in headless browsers ("Just a moment…") count as not reachable
  if (!error && /请稍候|just a moment|attention required/i.test(title)) error = `bot check: ${title}`;
  const ok = !error && good(found, expect);
  out.push({ site, url, expect, ok, error, switched, found });
  console.log(`${ok ? 'OK  ' : error ? 'N/A ' : 'MISS'} ${site.padEnd(10)} ${switched ? `[${switched}] ` : ''}${error || JSON.stringify(found)}`);
  await page.close();
}
await browser.close();
const i = process.argv.indexOf('--json');
if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 2));
const reached = out.filter((x) => !x.error);
console.log(`\n${reached.filter((x) => x.ok).length}/${reached.length} detected (${out.length - reached.length} not reachable)`);
