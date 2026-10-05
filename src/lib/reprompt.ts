// "使用前需要验证" (an item's `reprompt`, like Bitwarden's master password
// re-prompt) in the extension. The service worker enforces it: a reprompt
// item's secrets reach a page only after the user typed the master password
// in an extension-owned UI (inline menu, prompt iframe, popup), and that
// verification is bound to one context (nonce) and one item, and used once.
// Automatic paths (the fill shortcut, fill on page load) skip such items.

export interface Choice {
  vault_id: string;
  item_id: string;
  reprompt?: boolean;
}

export function itemKey(vaultId: string, itemId: string): string {
  return `${vaultId}/${itemId}`;
}

/** Where a verification is kept: an inline menu / prompt context, or the popup. */
export interface Verifiable {
  /** `itemKey` of the item the user verified for, until it is used. */
  verified?: string;
  /** When it was given (ms); it expires after `VERIFY_TTL_MS`. */
  verifiedAt?: number;
}

export const VERIFY_TTL_MS = 2 * 60_000;

export function grant(holder: Verifiable, vaultId: string, itemId: string, now = Date.now()) {
  holder.verified = itemKey(vaultId, itemId);
  holder.verifiedAt = now;
}

/**
 * Whether the item may be used here: items without `reprompt` always; a
 * reprompt item only with a fresh verification for exactly this item, which
 * this call uses up.
 */
export function consume(holder: Verifiable, item: Choice, now = Date.now()): boolean {
  if (!item.reprompt) return true;
  const ok =
    holder.verified === itemKey(item.vault_id, item.item_id) &&
    typeof holder.verifiedAt === 'number' &&
    now - holder.verifiedAt >= 0 &&
    now - holder.verifiedAt < VERIFY_TTL_MS;
  delete holder.verified;
  delete holder.verifiedAt;
  return ok;
}

/** The fill shortcut (Ctrl+Shift+L): the first match that does not ask for verification. */
export function shortcutTarget<T extends Choice>(list: T[]): T | undefined {
  return list.find((c) => !c.reprompt);
}

/** Fill on page load: only when exactly one login matches and it does not ask for verification. */
export function loadTarget<T extends Choice>(list: T[]): T | undefined {
  return list.length === 1 && !list[0]!.reprompt ? list[0] : undefined;
}

export interface Saved {
  reprompt?: boolean;
  username: string;
  password: string;
}

/**
 * What to offer after a form was submitted with `username` / `password`:
 * nothing when a saved login has exactly these values, an update when one has
 * the username, else a new login. A reprompt item with the same username
 * suppresses the offer whatever the password is, so a page cannot learn
 * whether a guessed password is the saved one from the prompt appearing.
 */
export function saveOffer(saved: Saved[], username: string, password: string): 'new' | 'update' | null {
  let offer: 'new' | 'update' | null = 'new';
  for (const s of saved) {
    if (s.username !== username) continue;
    if (s.reprompt || s.password === password) return null;
    offer = 'update';
  }
  return offer;
}
