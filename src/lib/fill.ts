// Filling inputs in a way frameworks (React, Vue, Angular) notice.

import type { ProfileControl, ProfileForm } from './forms';

const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

export function setValue(el: HTMLInputElement, value: string) {
  el.focus({ preventScroll: true });
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  // React tracks the value through the prototype setter
  if (valueSetter) valueSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  el.blur();
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

/** Loose comparison for option labels: case, spaces and administrative suffixes ignored. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔)+$/u, '');
}

/** Picks the option matching any of the wanted values; returns whether one matched. */
export function setSelect(el: HTMLSelectElement, wanted: string[]): boolean {
  const w = wanted.filter(Boolean).map(norm);
  const opts = Array.from(el.options);
  const opt =
    opts.find((o) => w.includes(norm(o.value)) || w.includes(norm(o.text))) ??
    opts.find((o) => {
      const t = norm(o.text);
      return t.length >= 2 && w.some((x) => x.length >= 2 && (t.startsWith(x) || x.startsWith(t)));
    });
  if (!opt) return false;
  el.focus({ preventScroll: true });
  if (selectSetter) selectSetter.call(el, opt.value);
  else el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return true;
}

const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

function monthNames(mm: string): string[] {
  const n = Number(mm);
  if (!n) return [mm];
  const en = MONTHS_EN[n - 1]!;
  return [mm, String(n), `${n}月`, `${MONTHS_ZH[n - 1]}月`, en, en.slice(0, 3)];
}

function hint(el: ProfileControl): string {
  return `${(el as HTMLInputElement).placeholder ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.name} ${el.id}`.toLowerCase();
}

/** Expiry in one input: MM/YY, MM/YYYY or YYYY-MM (type=month), guessed from the field. */
function expiryText(el: HTMLInputElement, mm: string, yyyy: string): string {
  if (el.type === 'month') return `${yyyy}-${mm}`;
  const h = hint(el);
  const long = h.includes('yyyy') || el.maxLength >= 7;
  const sep = /mm\s*-\s*yy/.test(h) ? '-' : h.includes(' / ') ? ' / ' : '/';
  return `${mm}${sep}${long ? yyyy : yyyy.slice(2)}`;
}

/**
 * Fills a card / identity form from the values the service worker sent
 * (keys as in `ProfileKey`, plus `full-address` for single address fields).
 * Returns how many fields were filled.
 */
export function fillProfile(form: ProfileForm, values: Record<string, string>): number {
  let n = 0;
  const mm = values['cc-exp-month'] ?? '';
  const yyyy = values['cc-exp-year'] ?? '';
  const hasParts = form.fields.has('province') || form.fields.has('city');
  for (const [key, el] of form.fields) {
    if ((el as HTMLInputElement).readOnly || el.disabled) continue;
    let v = values[key] ?? '';
    let alts: string[] = [v];
    if (key === 'cc-exp') v = mm && yyyy && el instanceof HTMLInputElement ? expiryText(el, mm, yyyy) : '';
    if (key === 'cc-exp-month') alts = monthNames(mm);
    if (key === 'cc-exp-year') {
      alts = [yyyy, yyyy.slice(2)];
      if (el instanceof HTMLInputElement && (el.maxLength === 2 || /(^|[^y])yy([^y]|$)/.test(hint(el)))) v = yyyy.slice(2);
    }
    if (key === 'street' && !hasParts) v = values['full-address'] || v;
    if (key === 'cc-number' && el instanceof HTMLInputElement && el.maxLength > 0 && el.maxLength < v.length) continue;
    if (!v) continue;
    if (el instanceof HTMLSelectElement) {
      if (setSelect(el, key === 'cc-exp-month' || key === 'cc-exp-year' ? alts : [v])) n++;
    } else {
      setValue(el, v);
      n++;
    }
  }
  return n;
}
