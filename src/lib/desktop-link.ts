// "Unlock with the desktop app" (design doc §4.5): native messaging to the
// NyaPassword desktop app (desktop/src-tauri/src/browser_bridge.rs has the
// protocol). The extension keeps a long-term ECDH P-256 key pair whose private
// key is a non-extractable WebCrypto key in IndexedDB; the user pairs it once
// (the desktop shows the same six digits as the popup). Afterwards, while the
// desktop app is unlocked, it sends the account key sealed to that key
// (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM, bound to the account and a
// fresh nonce); the service worker opens it and calls `unlockWithKey`, which
// checks the key against the account itself. When the desktop app locks, it
// tells connected extensions to lock. While it is locked, an *interactive*
// request (the user opened the popup / clicked in the menu) makes it show its
// own unlock screen and answer once unlocked (desktop-unlock.ts).

import { INTERACTIVE_TIMEOUT_MS } from './desktop-unlock';

export const HOST_NAME = 'app.nya.password';
const UNLOCK_INFO = 'npw/browser-bridge/unlock/v1';
const PAIR_INFO = 'npw/browser-bridge/pair/v1';
const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- crypto

/** A new pairing key pair; the private key cannot be exported. */
export async function generatePairingKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** SEC1 uncompressed (65 bytes). */
export async function rawPublicKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

/** The six digits shown on both sides while pairing. */
export async function pairingCode(publicKey: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(enc.encode(PAIR_INFO), publicKey)));
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

export interface Sealed {
  eph_public_key: string;
  iv: string;
  ciphertext: string;
}

/** Opens what the desktop app sealed to our pairing key. */
export async function openSealed(privateKey: CryptoKey, publicKey: Uint8Array, accountId: string, nonce: Uint8Array, s: Sealed): Promise<Uint8Array> {
  const ephRaw = unb64(s.eph_public_key);
  const eph = await crypto.subtle.importKey('raw', ephRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = concat(enc.encode(UNLOCK_INFO), ephRaw, publicKey, enc.encode(accountId));
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: concat(nonce), info }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv), additionalData: concat(enc.encode(UNLOCK_INFO), enc.encode(accountId)) }, key, unb64(s.ciphertext));
  return new Uint8Array(plain);
}

// ---------------------------------------------------------------- the pairing (IndexedDB: CryptoKey objects can be stored there, not in chrome.storage)

export interface Pairing {
  id: string;
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  accountId: string;
  serverUrl: string;
  /** The desktop app accepted it. */
  paired: boolean;
}

const DB = 'npw-desktop-link';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function kv<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(d.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

export const loadPairing = () => kv<Pairing | undefined>('readonly', (s) => s.get('pairing')).then((p) => p ?? null);
export const savePairing = (p: Pairing) => kv('readwrite', (s) => s.put(p, 'pairing'));
export const clearPairing = () => kv('readwrite', (s) => s.delete('pairing'));

// ---------------------------------------------------------------- the connection

export interface PortLike {
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(f: (m: unknown) => void): void };
  onDisconnect: { addListener(f: () => void): void };
}

export type Reply = Record<string, unknown> & { type: string; code?: string; message?: string };

/** One native messaging port with request / reply matching (`rid`) and pushed events. */
export class DesktopPort {
  private port: PortLike | null = null;
  private next = 1;
  private waiting = new Map<number, { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Why the port closed (Chrome's lastError text, or the host's error). */
  lastError = '';

  constructor(
    private connectFn: () => PortLike,
    private onEvent: (type: string) => void,
    private lastErrorFn: () => string = () => '',
  ) {}

  get connected(): boolean {
    return this.port !== null;
  }

  private open(): PortLike {
    if (this.port) return this.port;
    const p = this.connectFn();
    this.port = p;
    this.lastError = '';
    p.onMessage.addListener((m) => this.receive(m as Reply));
    p.onDisconnect.addListener(() => {
      if (this.port === p) this.port = null;
      this.lastError ||= explainNativeError(this.lastErrorFn()) || '桌面端断开了连接';
      for (const [rid, w] of this.waiting) {
        clearTimeout(w.timer);
        w.resolve({ type: 'error', code: 'disconnected', message: this.lastError });
        this.waiting.delete(rid);
      }
    });
    return p;
  }

  private receive(m: Reply) {
    const rid = typeof m.rid === 'number' ? m.rid : null;
    const w = rid !== null ? this.waiting.get(rid) : undefined;
    if (w && rid !== null) {
      clearTimeout(w.timer);
      this.waiting.delete(rid);
      w.resolve(m);
      return;
    }
    // errors without rid come from the host itself (e.g. the app is not running)
    if (m.type === 'error') this.lastError = String(m.message ?? m.code ?? 'error');
    else this.onEvent(m.type);
  }

  /** Sends a request; resolves with the reply (errors are replies of type `error`). */
  request(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply> {
    let p: PortLike;
    try {
      p = this.open();
    } catch (e) {
      return Promise.resolve({ type: 'error', code: 'unavailable', message: String((e as Error)?.message ?? e) });
    }
    const rid = this.next++;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(rid);
        resolve({ type: 'error', code: 'timeout', message: this.lastError || '桌面端没有响应' });
      }, timeoutMs);
      this.waiting.set(rid, { resolve, timer });
      p.postMessage({ ...msg, rid });
    });
  }

  close() {
    this.port?.disconnect();
    this.port = null;
  }
}

/**
 * Asks the desktop app for the account key and opens it. `interactive`: the
 * user asked (see desktop-unlock.ts); a locked desktop app then shows its
 * unlock screen and answers once unlocked, so the request waits long.
 */
export async function requestAccountKey(port: DesktopPort, pairing: Pairing, interactive = false): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const msg: Record<string, unknown> = { type: 'unlock', pairing_id: pairing.id, account_id: pairing.accountId, server_url: pairing.serverUrl, nonce: b64(nonce) };
  if (interactive) msg.interactive = true;
  const r = await port.request(msg, interactive ? INTERACTIVE_TIMEOUT_MS : 10_000);
  if (r.type !== 'unlock') throw { code: r.code ?? 'invalid', message: r.message ?? 'unexpected reply' };
  return openSealed(pairing.privateKey, pairing.publicKey, pairing.accountId, nonce, r as unknown as Sealed);
}

/** Chrome's native-messaging errors, in words the user can act on. */
export function explainNativeError(message: string): string {
  if (!message) return '';
  if (/host not found/i.test(message)) return '找不到 NyaPassword 桌面端：请确认桌面端已安装并至少运行过一次，且在桌面端“设置 → 浏览器扩展”里打开了联动、填入了本扩展的 ID';
  if (/forbidden/i.test(message)) return 'NyaPassword 桌面端没有允许这个扩展：请把本扩展的 ID 填到桌面端“设置 → 浏览器扩展”';
  if (/host has exited/i.test(message)) return 'NyaPassword 桌面端的连接中断了，请确认桌面端在运行后重试';
  return message;
}
