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
  /** "使用前需要验证": the master password is asked before filling (`ctx:verify`). */
  reprompt?: boolean;
}

/** What an inline menu / prompt iframe gets for its nonce. */
export interface Context {
  kind: 'fill' | 'save' | 'passkey';
  origin: string;
  host: string;
  /** set when the field is in a frame of another site than the page the user sees */
  topHost?: string;
  signedIn: boolean;
  locked: boolean;
  /** fill: opened by the user's click on the NyaPassword button (not by focusing a field) */
  explicit?: boolean;
  /** Locked and paired with the desktop app: whether it is being asked to unlock (`ctx:desktop`). */
  desktop?: { waiting: boolean; error: string };
  /** fill: 'username' | 'password' | 'otp' for logins, 'card' | 'identity' for profiles */
  fieldKind?: string;
  isNew?: boolean;
  candidates?: Candidate[];
  /** save */
  offer?: 'new' | 'update';
  username?: string;
  /** save: the submitted password (the prompt shows it masked; the user may edit both before saving) */
  password?: string;
  updateTitle?: string;
  /** save: this site's logins the prompt may update instead (never "使用前需要验证" items) */
  targets?: { vault_id: string; item_id: string; title: string; username: string }[];
  /** save: the login the offer updates ("vault|item"), '' for a new one */
  target?: string;
  vaults?: { id: string; name: string }[];
  /** passkey */
  op?: 'create' | 'get';
  rpId?: string;
  user?: string;
  passkeys?: { vault_id: string; item_id: string; passkey_id: string; title: string; user_name: string; reprompt?: boolean }[];
  logins?: Candidate[];
  /** get with no usable passkey: what the site asked for vs what the vault has (IDs shortened; not secret) */
  passkeyDiag?: { allowed: string[]; stored: { id: string; discoverable: boolean; user: string; title: string }[] };
}

/** A field's box in the top frame's viewport (CSS px). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the user changed in the save prompt. */
export interface SaveEdit {
  username: string;
  password: string;
  /** a new login's title */
  title?: string;
  /** update this login of the site instead of saving a new one */
  target?: { vault_id: string; item_id: string };
}

export type ContentRequest =
  /** `explicit`: the user clicked the NyaPassword button (may ask the desktop app to unlock). */
  | { t: 'inline:open'; fieldKind: string; isNew: boolean; explicit?: boolean }
  /** A subframe's menu: shown by the top frame at `rect`, so the subframe's size cannot clip it. */
  | { t: 'inline:show'; n: string; rect: Rect }
  /** A menu shown in another frame than its field's was closed (from either frame). */
  | { t: 'inline:close'; n: string }
  | { t: 'save:capture'; username: string; password: string }
  | { t: 'hello' }
  | { t: 'autofill:load' }
  | { t: 'passkey:begin'; op: 'create' | 'get'; request: string; conditional: boolean }
  | { t: 'passkey:abort'; n: string };

export type PageRequest =
  | { t: 'call'; m: string; a: unknown[] }
  | { t: 'ctx:get'; n: string }
  | { t: 'ctx:unlock'; n: string; password: string }
  /** The menu's "用桌面端解锁": an interactive request to the desktop app. */
  | { t: 'ctx:desktop'; n: string }
  | { t: 'ctx:verify'; n: string; vault_id: string; item_id: string; password: string }
  | { t: 'ctx:fill'; n: string; vault_id: string; item_id: string }
  | { t: 'ctx:generate'; n: string }
  | { t: 'ctx:save'; n: string; vault_id?: string; never?: boolean; edit?: SaveEdit }
  /** The prompt's content height, so its iframe covers no more of the page than needed. */
  | { t: 'ctx:resize'; n: string; h: number }
  | { t: 'ctx:passkey'; n: string; choice: { vault_id: string; item_id: string; passkey_id?: string } | { create: true; vault_id: string; target?: { vault_id: string; item_id: string } } }
  | { t: 'ctx:cancel'; n: string; fallback?: boolean }
  | { t: 'popup:fill'; tabId: number; vault_id: string; item_id: string }
  | { t: 'popup:candidates'; url: string }
  | { t: 'popup:verify'; vault_id: string; item_id: string; password: string }
  | { t: 'popup:secret'; vault_id: string; item_id: string; what: 'username' | 'password' | 'totp' }
  | { t: 'desktop:status' }
  /** `interactive`: the user asked (the popup opened): a locked desktop app shows its unlock screen. */
  | { t: 'desktop:unlock'; interactive?: boolean }
  | { t: 'desktop:pair' }
  | { t: 'desktop:unpair' }
  | { t: 'desktop:disconnect' };

/** "Unlock with the desktop app" as the popup shows it. */
export interface DesktopStatus {
  /** The setting is on and the nativeMessaging permission granted. */
  enabled: boolean;
  extensionId: string;
  paired: boolean;
  connected: boolean;
  /** null: could not ask the desktop app. */
  desktopUnlocked: boolean | null;
  pairing: { code: string; state: 'pairing' | 'paired' | 'error'; error: string } | null;
  error: string;
  /** An interactive request waits for the user to unlock the desktop app. */
  waiting?: boolean;
  /** Why the last interactive request failed. */
  waitError?: string;
}

export type ToContent =
  | { t: 'fill'; n?: string; username?: string; password?: string; totp?: string; generated?: string; profile?: Record<string, string> }
  | { t: 'close'; n: string }
  | { t: 'passkey:result'; reqId: string; response?: unknown; error?: { name: string; message: string }; fallback?: boolean }
  | { t: 'show:prompt'; n: string }
  /** top frame: show the menu of a field in a subframe */
  | { t: 'show:menu'; n: string; rect: Rect }
  /** top frame: whether that menu is visible (anti-clickjacking), asked before filling the subframe */
  | { t: 'menu:trusted'; n: string }
  | { t: 'resize'; n: string; h: number };

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
