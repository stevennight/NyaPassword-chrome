// Form field detection. Finds login forms (username, password, one-time
// code, new-password) in a document, including open shadow roots, using
// autocomplete attributes first and keyword heuristics (common/autofill) next.

import keywords from '../../../common/autofill/keywords.json';

export type FieldKind = 'username' | 'password' | 'new-password' | 'otp' | 'other';

export interface LoginForm {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  /** Second password field (sign-up / change-password forms). */
  confirm?: HTMLInputElement;
  otp?: HTMLInputElement;
  /** A sign-up or change-password form: offer the generator, not saved logins. */
  isNew: boolean;
  root: Element | Document | ShadowRoot;
}

const TEXTY = new Set(['text', 'email', 'tel', 'number', '', 'username']);

function lc(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

function has(list: string[], text: string): boolean {
  return list.some((k) => text.includes(k));
}

/** All inputs in a root, descending into open shadow roots. */
export function allInputs(root: Document | ShadowRoot | Element = document): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  const walk = (node: Document | ShadowRoot | Element) => {
    for (const el of Array.from(node.querySelectorAll('*'))) {
      if (el instanceof HTMLInputElement) out.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    }
  };
  walk(root);
  return out;
}

export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected || el.hidden || (el as HTMLInputElement).disabled) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && (st.opacity === '' ? 1 : Number(st.opacity)) > 0.05;
}

function labelText(el: HTMLInputElement): string {
  const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('title'), el.className];
  if (el.id) {
    const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) parts.push(l.textContent);
  }
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent);
  // a short text right before the input often is its label in Chinese sites
  const prev = el.previousElementSibling;
  if (prev && (prev.textContent ?? '').length < 20) parts.push(prev.textContent);
  return lc(parts.filter(Boolean).join(' '));
}

/** Classifies one input. */
export function classify(el: HTMLInputElement): FieldKind {
  const type = lc(el.type);
  const ac = lc(el.autocomplete);
  if (ac.includes('one-time-code')) return 'otp';
  if (ac.includes('new-password')) return 'new-password';
  if (ac.includes('current-password')) return 'password';
  if (ac.includes('username') || ac === 'email') return 'username';
  if (type === 'password') {
    const t = labelText(el);
    return has(keywords.new_password, t) ? 'new-password' : 'password';
  }
  if (!TEXTY.has(type)) return 'other';
  const t = labelText(el);
  if (has(keywords.captcha, t) || has(keywords.search, t) || has(keywords.sms_code, t)) return 'other';
  const max = el.maxLength;
  if (has(keywords.otp, t) && (max <= 0 || max <= 10) && !has(keywords.username, t)) return 'otp';
  if (has(keywords.username, t)) return 'username';
  return 'other';
}

function formRoot(el: HTMLInputElement): Element | Document | ShadowRoot {
  return el.form ?? el.closest('[role="form"], form, .login, .login-form, .signin') ?? (el.getRootNode() as Document | ShadowRoot);
}

/** Login forms in the document. */
export function findForms(doc: Document = document): LoginForm[] {
  const inputs = allInputs(doc).filter(isVisible);
  const groups = new Map<Element | Document | ShadowRoot, HTMLInputElement[]>();
  for (const i of inputs) {
    const r = formRoot(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const forms: LoginForm[] = [];
  for (const [root, list] of groups) {
    const kinds = list.map((i) => [i, classify(i)] as const);
    const passwords = kinds.filter(([, k]) => k === 'password' || k === 'new-password').map(([i]) => i);
    const otp = kinds.find(([, k]) => k === 'otp')?.[0];
    let username: HTMLInputElement | undefined;
    if (passwords.length) {
      // the closest username-ish field before the first password field
      const first = passwords[0]!;
      const before = list.filter((i) => i !== first && (i.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      username = [...before].reverse().find((i) => classify(i) === 'username') ?? [...before].reverse().find((i) => TEXTY.has(lc(i.type)) && classify(i) !== 'otp' && classify(i) !== 'other');
    } else {
      username = kinds.find(([, k]) => k === 'username')?.[0];
    }
    if (!passwords.length && !username && !otp) continue;
    if (!passwords.length && username && !otp) {
      // username-only step of a multi-step login: only when it looks like one
      const t = labelText(username) + ' ' + lc((root as Element).textContent?.slice(0, 300));
      if (!has(['login', 'sign in', 'signin', 'log in', '登录', '下一步', 'next', 'continue'], t) && !lc(username.autocomplete).includes('username')) continue;
    }
    const hint = lc((root as Element).textContent?.slice(0, 500)) + ' ' + lc((root as HTMLFormElement).action);
    const isNew = passwords.some((p) => classify(p) === 'new-password') || passwords.length >= 2 || (has(keywords.register, hint) && !has(['login', 'sign in', '登录'], hint));
    forms.push({ username, password: passwords[0], confirm: passwords[1], otp, isNew, root });
  }
  return forms;
}

/** The form a given input belongs to (if it is one of its login fields). */
export function formOf(el: HTMLInputElement, forms: LoginForm[]): LoginForm | undefined {
  return forms.find((f) => f.username === el || f.password === el || f.confirm === el || f.otp === el);
}
