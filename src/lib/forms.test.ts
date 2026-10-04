// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classify, findForms } from './forms';

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
