import { describe, expect, it } from 'vitest';
import { consume, grant, loadTarget, saveOffer, shortcutTarget, VERIFY_TTL_MS, type Verifiable } from './reprompt';

const plain = { vault_id: 'v', item_id: 'a' };
const guarded = { vault_id: 'v', item_id: 'b', reprompt: true };
const other = { vault_id: 'v', item_id: 'c', reprompt: true };

describe('verification for reprompt items', () => {
  it('items without reprompt need nothing', () => {
    expect(consume({}, plain)).toBe(true);
    expect(consume({}, { ...plain, reprompt: false })).toBe(true);
  });

  it('a reprompt item needs a verification for exactly that item', () => {
    const h: Verifiable = {};
    expect(consume(h, guarded)).toBe(false);
    grant(h, 'v', 'c');
    expect(consume(h, guarded)).toBe(false);
    grant(h, 'w', 'b');
    expect(consume(h, guarded), 'same item id in another vault').toBe(false);
    grant(h, 'v', 'b');
    expect(consume(h, guarded)).toBe(true);
  });

  it('a verification is used once, also when it was for another item', () => {
    const h: Verifiable = {};
    grant(h, 'v', 'b');
    expect(consume(h, guarded)).toBe(true);
    expect(consume(h, guarded)).toBe(false);
    grant(h, 'v', 'b');
    expect(consume(h, other)).toBe(false);
    expect(consume(h, guarded), 'a failed attempt drops it').toBe(false);
  });

  it('a verification expires', () => {
    const h: Verifiable = {};
    grant(h, 'v', 'b', 1_000);
    expect(consume(h, guarded, 1_000 + VERIFY_TTL_MS)).toBe(false);
    grant(h, 'v', 'b', 1_000);
    expect(consume(h, guarded, 500), 'clock went backwards').toBe(false);
    grant(h, 'v', 'b', 1_000);
    expect(consume(h, guarded, 1_000 + VERIFY_TTL_MS - 1)).toBe(true);
  });
});

describe('automatic fills skip reprompt items', () => {
  it('the shortcut takes the first match that does not ask', () => {
    expect(shortcutTarget([guarded, plain])).toBe(plain);
    expect(shortcutTarget([guarded, other])).toBeUndefined();
    expect(shortcutTarget([])).toBeUndefined();
  });

  it('fill on load needs exactly one match that does not ask', () => {
    expect(loadTarget([plain])).toBe(plain);
    expect(loadTarget([guarded])).toBeUndefined();
    expect(loadTarget([plain, guarded])).toBeUndefined();
  });
});

describe('save / update offer', () => {
  const saved = (username: string, password: string, reprompt = false) => ({ username, password, reprompt });

  it('offers new, update or nothing', () => {
    expect(saveOffer([], 'me', 'p')).toBe('new');
    expect(saveOffer([saved('you', 'p')], 'me', 'p')).toBe('new');
    expect(saveOffer([saved('me', 'old')], 'me', 'p')).toBe('update');
    expect(saveOffer([saved('me', 'p')], 'me', 'p')).toBeNull();
    expect(saveOffer([saved('me', 'old'), saved('me', 'p')], 'me', 'p')).toBeNull();
  });

  it('never reveals whether the password of a reprompt item matched', () => {
    expect(saveOffer([saved('me', 'right', true)], 'me', 'right')).toBeNull();
    expect(saveOffer([saved('me', 'right', true)], 'me', 'wrong')).toBeNull();
    // another username is not about that item
    expect(saveOffer([saved('me', 'right', true)], 'you', 'right')).toBe('new');
  });
});
