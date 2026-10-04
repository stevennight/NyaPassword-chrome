// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classify, findForms, findProfiles } from './forms';
import { fillProfile } from './fill';

// jsdom has no CSS.escape
if (!globalThis.CSS?.escape) (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
// jsdom has no layout: make every element "visible"
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { value: () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }) });

function page(html: string) {
  document.body.innerHTML = html;
  return findForms(document);
}

describe('form detection', () => {
  it('finds a Chinese login form without autocomplete attributes', () => {
    const [f] = page(`<form><label>账号 <input name="account" placeholder="手机号 / 邮箱"></label>
      <label>密码 <input name="pwd" type="password"></label><label>动态码 <input name="code" maxlength="6"></label><button>登录</button></form>`);
    expect(f?.username?.name).toBe('account');
    expect(f?.password?.name).toBe('pwd');
    expect(f?.otp?.name).toBe('code');
    expect(f?.isNew).toBe(false);
  });

  it('uses autocomplete attributes first', () => {
    const [f] = page(`<form><input id="a" autocomplete="username"><input id="b" type="password" autocomplete="current-password"><input id="c" autocomplete="one-time-code"></form>`);
    expect(f?.username?.id).toBe('a');
    expect(f?.otp?.id).toBe('c');
  });

  it('recognizes sign-up forms', () => {
    const [f] = page(`<form><h2>注册</h2><input name="email"><input type="password" name="password"><input type="password" name="confirm"></form>`);
    expect(f?.isNew).toBe(true);
    expect(f?.confirm?.name).toBe('confirm');
  });

  it('ignores search boxes and captchas', () => {
    document.body.innerHTML = `<input name="q" placeholder="搜索"><input name="captcha" placeholder="图形验证码">`;
    for (const el of Array.from(document.querySelectorAll('input'))) expect(classify(el)).toBe('other');
    expect(findForms(document)).toHaveLength(0);
  });

  it('handles a username-only first step', () => {
    const [f] = page(`<form><h3>登录</h3><input name="login" autocomplete="username"><button>下一步</button></form>`);
    expect(f?.username?.name).toBe('login');
    expect(f?.password).toBeUndefined();
  });
});

describe('card and address forms', () => {
  it('finds a card form by autocomplete and keywords, selects included', () => {
    document.body.innerHTML = `<form>
      <input name="holder" placeholder="持卡人姓名">
      <input autocomplete="cc-number" id="num">
      <select name="exp_month"><option value="">月</option><option value="1">01</option><option value="3">03</option></select>
      <select name="exp_year"><option value="">年</option><option>2026</option><option>2027</option></select>
      <input name="cvv" maxlength="4"></form>`;
    const logins = findForms(document);
    const [p] = findProfiles(document, logins);
    expect(p?.kind).toBe('card');
    expect(p?.fields.get('cc-number')?.id).toBe('num');
    expect((p?.fields.get('cc-name') as HTMLInputElement).name).toBe('holder');
    expect(p?.fields.get('cc-exp-month')?.name).toBe('exp_month');
    expect(p?.fields.get('cc-exp-year')?.name).toBe('exp_year');
    expect(p?.fields.get('cc-csc')?.name).toBe('cvv');
  });

  it('finds a Chinese shipping address form', () => {
    document.body.innerHTML = `<form><label>收货人 <input name="consignee"></label><label>手机号码 <input name="mobile" type="tel"></label>
      <select name="province"><option>北京</option><option value="gd">广东</option></select><label>城市 <input name="city"></label>
      <label>详细地址 <input name="detail"></label><label>邮编 <input name="zip"></label></form>`;
    const [p] = findProfiles(document, findForms(document));
    expect(p?.kind).toBe('identity');
    expect([...p!.fields.keys()].sort()).toEqual(['city', 'name', 'postal-code', 'province', 'street', 'tel']);
  });

  it('leaves login forms and lone fields alone', () => {
    document.body.innerHTML = `<form><input name="email" type="email"><input type="password" name="pw"></form><input name="newsletter" type="email">`;
    expect(findProfiles(document, findForms(document))).toHaveLength(0);
  });

  it('fills cards and addresses, matching select options loosely', () => {
    document.body.innerHTML = `<form><input autocomplete="cc-name" id="n"><input autocomplete="cc-number" id="c"><input autocomplete="cc-exp" id="e" placeholder="MM/YY"><input autocomplete="cc-csc" id="s"></form>
      <form><input autocomplete="name" id="fn"><input autocomplete="tel" id="t"><select autocomplete="address-level1" id="pr"><option value="11">北京市</option><option value="44">广东省</option></select>
      <input autocomplete="address-level2" id="ci"><input autocomplete="street-address" id="st"></form>`;
    const [card, id] = findProfiles(document, findForms(document));
    const v = (s: string) => (document.getElementById(s) as HTMLInputElement).value;
    expect(fillProfile(card!, { 'cc-name': 'ZHANG SAN', 'cc-number': '6222020200112233445', 'cc-exp-month': '03', 'cc-exp-year': '2029', 'cc-csc': '123' })).toBe(4);
    expect([v('n'), v('c'), v('e'), v('s')]).toEqual(['ZHANG SAN', '6222020200112233445', '03/29', '123']);
    fillProfile(id!, { name: '张三', tel: '13800000000', province: '广东', city: '深圳市', street: '科技园路 1 号', 'full-address': '广东深圳市科技园路 1 号' });
    expect([v('fn'), v('t'), v('pr'), v('ci'), v('st')]).toEqual(['张三', '13800000000', '44', '深圳市', '科技园路 1 号']);
  });

  it('puts the whole address into a single address field', () => {
    document.body.innerHTML = `<form><input autocomplete="name" id="fn"><input autocomplete="street-address" id="st"></form>`;
    const [id] = findProfiles(document, findForms(document));
    fillProfile(id!, { name: '张三', street: '科技园路 1 号', 'full-address': '广东省深圳市南山区科技园路 1 号' });
    expect((document.getElementById('st') as HTMLInputElement).value).toBe('广东省深圳市南山区科技园路 1 号');
  });
});

describe('hostile pages', () => {
  it('survives DOM clobbering (a control named "action")', () => {
    const [f] = page(`<form><input name="action" type="hidden" value="x"><input name="identifier" autocomplete="username"><button>下一步</button></form>`);
    expect(f?.username?.name).toBe('identifier');
  });
});

describe('sign-in vs sign-up', () => {
  it('treats a lone new-password field in a login form as a login (anti-autofill markup)', () => {
    const [f] = page(`<form><h3>密码登录</h3><input name="email" placeholder="邮箱账号或手机号码"><input type="password" name="password" autocomplete="new-password"><a>注册新账号</a></form>`);
    expect(f?.password?.name).toBe('password');
    expect(f?.isNew).toBe(false);
  });

  it('keeps a sign-up form with a login link as sign-up', () => {
    const [f] = page(`<form><h3>注册</h3><input name="email"><input type="password" name="password" autocomplete="new-password"><a>已有账号？登录</a></form>`);
    expect(f?.isNew).toBe(true);
  });
});
