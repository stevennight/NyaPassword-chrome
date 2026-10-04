// Form field detection. Finds login forms (username, password, one-time
// code, new-password) and payment-card / identity-address forms in a document,
// including open shadow roots, using autocomplete attributes first and
// keyword heuristics (common/autofill) next.

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

/** Lower-cased text; anything else (a form property clobbered by a control named
 * "action" or "name", an SVG className object…) counts as empty. */
function lc(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
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

/** Text describing a field; `near` adds the text right before it (weaker evidence). */
function labelText(el: HTMLInputElement | HTMLSelectElement, near = true): string {
  const parts = [el.name, el.id, (el as HTMLInputElement).placeholder, el.getAttribute('aria-label'), el.getAttribute('title'), el.className];
  if (el.id) {
    const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) parts.push(l.textContent);
  }
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent);
  // a short text right before the input often is its label in Chinese sites
  // (not when it is another field's label)
  const prev = near ? el.previousElementSibling : null;
  if (prev && (prev.textContent ?? '').length < 20 && !prev.querySelector('input, select, textarea')) parts.push(prev.textContent);
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

/** The start of a form's text, whitespace collapsed (markup indentation can fill hundreds of characters). */
function rootText(root: Element | Document | ShadowRoot, n: number): string {
  const el = root instanceof Document ? root.body : root;
  if (!el) return '';
  // walk text nodes and stop early: a whole page's textContent can be megabytes
  const doc = el.ownerDocument ?? (el as unknown as Document);
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(t.parentNode?.nodeName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let out = '';
  for (let t = walker.nextNode(); t && out.length < n; t = walker.nextNode()) {
    const v = (t.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (v) out += (out ? ' ' : '') + v;
  }
  return out.slice(0, n);
}

const LOGIN_WORDS = ['login', 'log in', 'sign in', 'signin', '登录', '登入'];

/** First position of any keyword, ignoring whitespace ("登 录" is how some sites space out a button). */
function firstIndex(list: string[], text: string): number {
  const t = text.replace(/\s+/g, '');
  let best = -1;
  for (const k of list) {
    const i = t.indexOf(k.replace(/\s+/g, ''));
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
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
      const t = labelText(username) + ' ' + lc(rootText(root, 300));
      if (!has([...LOGIN_WORDS, '下一步', 'next', 'continue'], t) && !lc(username.autocomplete).includes('username')) continue;
    }
    const hint = lc(rootText(root, 500)) + ' ' + lc((root as Element).getAttribute?.('action'));
    // what the form says first ("登录" heading vs "注册" heading; the other one is usually a link)
    const loginAt = firstIndex(LOGIN_WORDS, hint);
    const registerAt = firstIndex(keywords.register, hint);
    const saysLogin = loginAt >= 0 && (registerAt < 0 || loginAt < registerAt);
    const saysRegister = registerAt >= 0 && !saysLogin;
    // a lone "new-password" field in a login form: sites set it to stop browsers from filling
    const markedNew = passwords.some((p) => classify(p) === 'new-password') && !(passwords.length === 1 && saysLogin);
    const isNew = markedNew || passwords.length >= 2 || saysRegister;
    forms.push({ username, password: passwords[0], confirm: passwords[1], otp, isNew, root });
  }
  return forms;
}

/** The form a given input belongs to (if it is one of its login fields). */
export function formOf(el: HTMLInputElement, forms: LoginForm[]): LoginForm | undefined {
  return forms.find((f) => f.username === el || f.password === el || f.confirm === el || f.otp === el);
}

// ---------------------------------------------------------------- cards and addresses

export type ProfileKey =
  | 'cc-name' | 'cc-number' | 'cc-exp' | 'cc-exp-month' | 'cc-exp-year' | 'cc-csc'
  | 'name' | 'given-name' | 'family-name' | 'tel' | 'email' | 'organization'
  | 'street' | 'province' | 'city' | 'district' | 'postal-code' | 'country';

export type ProfileControl = HTMLInputElement | HTMLSelectElement;

export interface ProfileForm {
  kind: 'card' | 'identity';
  fields: Map<ProfileKey, ProfileControl>;
  root: Element | Document | ShadowRoot;
}

/** HTML autocomplete tokens (the last token of the attribute) → our keys. */
const AC_PROFILE: Record<string, ProfileKey> = {
  'cc-name': 'cc-name', 'cc-number': 'cc-number', 'cc-exp': 'cc-exp', 'cc-exp-month': 'cc-exp-month', 'cc-exp-year': 'cc-exp-year', 'cc-csc': 'cc-csc',
  name: 'name', 'given-name': 'given-name', 'family-name': 'family-name', tel: 'tel', 'tel-national': 'tel', email: 'email', organization: 'organization',
  'street-address': 'street', 'address-line1': 'street', 'address-level1': 'province', 'address-level2': 'city', 'address-level3': 'district',
  'postal-code': 'postal-code', country: 'country', 'country-name': 'country',
};

/** Keyword lists in the order they are tried (more specific first). */
const KW_PROFILE: [ProfileKey, string[]][] = [
  ['cc-number', keywords.card_number],
  ['cc-csc', keywords.card_cvc],
  ['cc-exp-month', keywords.card_exp_month],
  ['cc-exp-year', keywords.card_exp_year],
  ['cc-exp', keywords.card_exp],
  ['cc-name', keywords.card_name],
  ['postal-code', keywords.postal_code],
  ['given-name', keywords.given_name],
  ['family-name', keywords.family_name],
  ['name', keywords.full_name],
  ['email', keywords.email],
  ['tel', keywords.phone],
  ['organization', keywords.company],
  ['country', keywords.country],
  ['province', keywords.province],
  ['city', keywords.city],
  ['district', keywords.district],
  ['street', keywords.street],
];

const IDENTITY_STRONG = new Set<ProfileKey>(['street', 'province', 'city', 'district', 'postal-code', 'name', 'given-name', 'family-name']);

/** Classifies an input or select as a card / identity field. */
export function classifyProfile(el: ProfileControl): ProfileKey | null {
  const ac = lc(el.getAttribute('autocomplete')).trim().split(/\s+/).pop() ?? '';
  if (ac === 'off' || ac === 'on' || !ac) {
    /* fall through to heuristics */
  } else if (AC_PROFILE[ac]) {
    return AC_PROFILE[ac]!;
  } else if (/password|username|one-time-code/.test(ac)) {
    return null;
  }
  if (el instanceof HTMLInputElement) {
    const type = lc(el.type);
    if (type === 'email') return 'email';
    if (type === 'tel') return 'tel';
    if (!TEXTY.has(type) && type !== 'month') return null;
  }
  const t = labelText(el);
  if (has(keywords.search, t) || has(keywords.captcha, t) || has(keywords.sms_code, t)) return null;
  // the field's own name / label first, then nearby text
  for (const text of [labelText(el, false), t]) for (const [key, list] of KW_PROFILE) if (has(list, text)) return key;
  return null;
}

/** All inputs and selects, descending into open shadow roots. */
function allControls(root: Document | ShadowRoot | Element): ProfileControl[] {
  const out: ProfileControl[] = [];
  const walk = (node: Document | ShadowRoot | Element) => {
    for (const el of Array.from(node.querySelectorAll('*'))) {
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) out.push(el);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr);
    }
  };
  walk(root);
  return out;
}

function profileRoot(el: ProfileControl): Element | Document | ShadowRoot {
  return el.form ?? el.closest('form, [role="form"], fieldset') ?? (el.getRootNode() as Document | ShadowRoot);
}

/** Payment-card and identity / address forms (fields of login forms excluded). */
export function findProfiles(doc: Document = document, logins: LoginForm[] = []): ProfileForm[] {
  const taken = new Set<Element>();
  for (const f of logins) for (const el of [f.username, f.password, f.confirm]) if (el) taken.add(el);
  const groups = new Map<Element | Document | ShadowRoot, ProfileControl[]>();
  for (const el of allControls(doc)) {
    if (taken.has(el) || !isVisible(el)) continue;
    const r = profileRoot(el);
    groups.set(r, [...(groups.get(r) ?? []), el]);
  }
  const out: ProfileForm[] = [];
  for (const [root, list] of groups) {
    const fields = new Map<ProfileKey, ProfileControl>();
    for (const el of list) {
      const k = classifyProfile(el);
      if (k && !fields.has(k)) fields.set(k, el);
    }
    const keys = [...fields.keys()];
    if (fields.has('cc-number')) {
      out.push({ kind: 'card', fields: new Map(keys.filter((k) => k.startsWith('cc-')).map((k) => [k, fields.get(k)!])), root });
    }
    const id = keys.filter((k) => !k.startsWith('cc-'));
    if (id.length >= 2 && id.some((k) => IDENTITY_STRONG.has(k))) {
      out.push({ kind: 'identity', fields: new Map(id.map((k) => [k, fields.get(k)!])), root });
    }
  }
  return out;
}

/** The card / identity form an input belongs to. */
export function profileOf(el: Element, profiles: ProfileForm[]): ProfileForm | undefined {
  return profiles.find((p) => [...p.fields.values()].includes(el as ProfileControl));
}
