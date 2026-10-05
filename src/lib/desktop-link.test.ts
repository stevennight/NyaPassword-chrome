// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64, DesktopPort, generatePairingKey, openSealed, pairingCode, rawPublicKey, requestAccountKey, unb64, type PortLike } from './desktop-link';

// The vector of desktop/src-tauri/src/browser_bridge.rs (cross_language_vector):
// extension key d = 0x11…, desktop ephemeral key d = 0x22…, iv = 0x33…,
// nonce = 0x44…, sealed secret = 0x55… for this account.
const EXT_PUBLIC = 'BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q=';
const ACCOUNT = '0190d5a4-0000-7000-8000-000000000001';
const SEALED = {
  eph_public_key: 'BNZak5d8qj0bCBhS/1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc/3bZ1XwW9UHw8Uz/OnJEoU=',
  iv: b64(new Uint8Array(12).fill(0x33)),
  ciphertext: 'JixJdUj5r48Fx+YDC1Ib9KrF2mco+vG4OuilmrOift7VWe8h4qRqshq047wJrhaX',
};

const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vectorKey(): Promise<CryptoKey> {
  const pub = unb64(EXT_PUBLIC);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d: b64url(new Uint8Array(32).fill(0x11)), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

describe('desktop link crypto', () => {
  it('opens what the desktop app (Rust) sealed', async () => {
    const key = await vectorKey();
    const plain = await openSealed(key, unb64(EXT_PUBLIC), ACCOUNT, new Uint8Array(32).fill(0x44), SEALED);
    expect([...plain]).toEqual(new Array(32).fill(0x55));
  });

  it('refuses another account, nonce or tampered data', async () => {
    const key = await vectorKey();
    const pub = unb64(EXT_PUBLIC);
    const nonce = new Uint8Array(32).fill(0x44);
    await expect(openSealed(key, pub, 'another-account', nonce, SEALED)).rejects.toBeTruthy();
    await expect(openSealed(key, pub, ACCOUNT, new Uint8Array(32).fill(0x45), SEALED)).rejects.toBeTruthy();
    const ct = unb64(SEALED.ciphertext);
    ct[0]! ^= 1;
    await expect(openSealed(key, pub, ACCOUNT, nonce, { ...SEALED, ciphertext: b64(ct) })).rejects.toBeTruthy();
  });

  it('pairing code matches the desktop app', async () => {
    expect(await pairingCode(unb64(EXT_PUBLIC))).toBe('562741');
  });

  it('pairing keys cannot be exported', async () => {
    const kp = await generatePairingKey();
    expect(kp.privateKey.extractable).toBe(false);
    expect((await rawPublicKey(kp.publicKey)).length).toBe(65);
    await expect(crypto.subtle.exportKey('jwk', kp.privateKey)).rejects.toBeTruthy();
  });
});

/** A fake native port: `answer` decides the reply to each request. */
function fakePort(answer: (m: Record<string, unknown>) => Record<string, unknown> | null) {
  const msg: ((m: unknown) => void)[] = [];
  const disc: (() => void)[] = [];
  const port: PortLike & { push(m: unknown): void; drop(): void } = {
    postMessage(m) {
      const r = answer(m as Record<string, unknown>);
      if (r) queueMicrotask(() => msg.forEach((f) => f({ ...r, rid: (m as { rid: number }).rid })));
    },
    disconnect() {},
    onMessage: { addListener: (f) => msg.push(f) },
    onDisconnect: { addListener: (f) => disc.push(f) },
    push: (m) => msg.forEach((f) => f(m)),
    drop: () => disc.forEach((f) => f()),
  };
  return port;
}

describe('desktop port', () => {
  it('matches replies, delivers pushed events, fails pending requests on disconnect', async () => {
    const events: string[] = [];
    const fake = fakePort((m) => (m.type === 'hello' ? { type: 'hello', unlocked: true } : null));
    const port = new DesktopPort(() => fake, (t) => events.push(t), () => 'Native host has exited.');
    const r = await port.request({ type: 'hello' });
    expect(r).toMatchObject({ type: 'hello', unlocked: true });
    fake.push({ type: 'locked' });
    expect(events).toEqual(['locked']);
    const pending = port.request({ type: 'never answered' });
    fake.drop();
    expect(await pending).toMatchObject({ type: 'error', code: 'disconnected', message: expect.stringContaining('连接中断') });
    expect(port.connected).toBe(false);
  });

  it('times out and reports host errors', async () => {
    const fake = fakePort(() => null);
    const port = new DesktopPort(() => fake, () => {});
    const p = port.request({ type: 'hello' }, 30);
    fake.push({ type: 'error', code: 'app_not_running', message: '桌面端没有运行' });
    expect(await p).toMatchObject({ code: 'timeout', message: '桌面端没有运行' });
  });

  it('requests and opens the account key', async () => {
    // a desktop side in TypeScript for the test: seal like browser_bridge.rs does
    const ext = await generatePairingKey();
    const extPub = await rawPublicKey(ext.publicKey);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const fake = fakePort(() => null);
    fake.postMessage = (m: unknown) => {
      const req = m as { rid: number; nonce: string; account_id: string };
      void sealForTest(extPub, req.account_id, unb64(req.nonce), secret).then((s) => fake.push({ type: 'unlock', rid: req.rid, ...s }));
    };
    const port = new DesktopPort(() => fake, () => {});
    const got = await requestAccountKey(port, { id: 'p1', privateKey: ext.privateKey, publicKey: extPub, accountId: ACCOUNT, serverUrl: 'https://vault.example.com', paired: true });
    expect([...got]).toEqual([...secret]);
  });
});

async function sealForTest(extPub: Uint8Array<ArrayBuffer>, account: string, nonce: Uint8Array<ArrayBuffer>, secret: Uint8Array<ArrayBuffer>) {
  const enc = new TextEncoder();
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const peer = await crypto.subtle.importKey('raw', extPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const cat = (...p: Uint8Array[]) => {
    const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let i = 0;
    for (const x of p) (o.set(x, i), (i += x.length));
    return o;
  };
  const info = cat(enc.encode('npw/browser-bridge/unlock/v1'), ephRaw, extPub, enc.encode(account));
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: nonce, info }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: cat(enc.encode('npw/browser-bridge/unlock/v1'), enc.encode(account)) }, key, secret);
  return { eph_public_key: b64(ephRaw), iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}

describe('native messaging errors', () => {
  it('explains Chrome errors in Chinese and keeps others', async () => {
    const { explainNativeError } = await import('./desktop-link');
    expect(explainNativeError('Specified native messaging host not found.')).toContain('找不到 NyaPassword 桌面端');
    expect(explainNativeError('Access to the specified native messaging host is forbidden.')).toContain('没有允许这个扩展');
    expect(explainNativeError('Native host has exited.')).toContain('中断');
    expect(explainNativeError('something else')).toBe('something else');
    expect(explainNativeError('')).toBe('');
  });
});
