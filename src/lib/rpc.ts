// Messages between extension parts. Privileged calls (`call`) are only
// accepted from extension pages; content scripts get a narrow set whose
// origin the service worker takes from Chrome, never from the message.

export interface Candidate {
  vault_id: string;
  item_id: string;
  title: string;
  username: string;
  has_totp: boolean;
  passkeys: number;
}

/** What an inline menu / prompt iframe gets for its nonce. */
export interface Context {
  kind: 'fill' | 'save' | 'passkey';
  origin: string;
  host: string;
  signedIn: boolean;
  locked: boolean;
  /** fill: 'username' | 'password' | 'otp' for logins, 'card' | 'identity' for profiles */
  fieldKind?: string;
  isNew?: boolean;
  candidates?: Candidate[];
  /** save */
  offer?: 'new' | 'update';
  username?: string;
  updateTitle?: string;
  vaults?: { id: string; name: string }[];
  /** passkey */
  op?: 'create' | 'get';
  rpId?: string;
  user?: string;
  passkeys?: { vault_id: string; item_id: string; passkey_id: string; title: string; user_name: string }[];
  logins?: Candidate[];
}

export type ContentRequest =
  | { t: 'inline:open'; fieldKind: string; isNew: boolean }
  | { t: 'save:capture'; username: string; password: string }
  | { t: 'hello' }
  | { t: 'autofill:load' }
  | { t: 'passkey:begin'; op: 'create' | 'get'; request: string; conditional: boolean };

export type PageRequest =
  | { t: 'call'; m: string; a: unknown[] }
  | { t: 'ctx:get'; n: string }
  | { t: 'ctx:unlock'; n: string; password: string }
  | { t: 'ctx:fill'; n: string; vault_id: string; item_id: string }
  | { t: 'ctx:generate'; n: string }
  | { t: 'ctx:save'; n: string; vault_id?: string; never?: boolean }
  | { t: 'ctx:passkey'; n: string; choice: { vault_id: string; item_id: string; passkey_id?: string } | { create: true; vault_id: string; target?: { vault_id: string; item_id: string } } }
  | { t: 'ctx:cancel'; n: string; fallback?: boolean }
  | { t: 'popup:fill'; tabId: number; vault_id: string; item_id: string }
  | { t: 'popup:candidates'; url: string };

export type ToContent =
  | { t: 'fill'; n?: string; username?: string; password?: string; totp?: string; generated?: string; profile?: Record<string, string> }
  | { t: 'close'; n: string }
  | { t: 'passkey:result'; reqId: string; response?: unknown; error?: { name: string; message: string }; fallback?: boolean }
  | { t: 'show:prompt'; n: string };

export interface Reply<T = unknown> {
  ok: boolean;
  v?: T;
  e?: { code: string; message: string };
}

export async function send<T>(msg: ContentRequest | PageRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!r) throw { code: 'network', message: 'the extension did not answer' };
  if (!r.ok) throw r.e ?? { code: 'invalid', message: 'error' };
  return r.v as T;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
