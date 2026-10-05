// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DesktopUnlocker, INTERACTIVE_TIMEOUT_MS, type UnlockDeps } from './desktop-unlock';
import { DesktopPort, requestAccountKey, type PortLike } from './desktop-link';

interface P {
  paired: boolean;
  accountId: string;
}

/** A fake extension + desktop app: `answer` decides each key request. */
function setup(answer: (interactive: boolean) => Promise<Uint8Array>) {
  const state = { enabled: true, signed_in: true, unlocked: false, account_id: 'acc-1' };
  let pairing: P | null = { paired: true, accountId: 'acc-1' };
  const requests: boolean[] = [];
  const applied: Uint8Array[] = [];
  const deps: UnlockDeps<P> = {
    enabled: async () => state.enabled,
    lockState: async () => ({ ...state }),
    pairing: async () => pairing,
    requestKey: (_p, interactive) => {
      requests.push(interactive);
      return answer(interactive);
    },
    unlockWithKey: async (key) => {
      applied.push(new Uint8Array(key));
      state.unlocked = true;
    },
  };
  return { u: new DesktopUnlocker(deps), state, requests, applied, setPairing: (p: P | null) => (pairing = p) };
}

const key = () => new Uint8Array(32).fill(7);
const flush = () => new Promise((r) => setTimeout(r, 0));
const locked = () => Promise.reject({ code: 'locked', message: 'NyaPassword 桌面端已锁定' });

/** A promise resolved from outside (the user unlocking the desktop app later). */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { p, resolve, reject };
}

describe('unlocking through the desktop app', () => {
  it('automatic attempts use an unlocked desktop app and never wait for a locked one', async () => {
    const t = setup((interactive) => (interactive ? Promise.resolve(key()) : locked()));
    expect(await t.u.unlock(false)).toBe(false);
    expect(t.requests).toEqual([false]);
    expect(t.u.waiting).toBe(false);
    expect(t.u.error).toBe('');
    expect(t.applied).toEqual([]);

    const open = setup(() => Promise.resolve(key()));
    expect(await open.u.unlock(false)).toBe(true);
    expect(open.applied.length).toBe(1);
    // already unlocked: no request
    expect(await open.u.unlock(false)).toBe(true);
    expect(open.requests).toEqual([false]);
  });

  it('other automatic failures are reported to the caller', async () => {
    const t = setup(() => Promise.reject({ code: 'app_not_running', message: '桌面端没有运行' }));
    await expect(t.u.unlock(false)).rejects.toMatchObject({ code: 'app_not_running' });
  });

  it('an interactive request waits for the user, one at a time', async () => {
    const reply = later<Uint8Array>();
    const t = setup(() => reply.p);
    const first = t.u.unlock(true);
    const second = t.u.unlock(true);
    expect(t.u.waiting).toBe(true);
    await flush();
    // the popup and a menu asking together: still one request to the desktop app
    expect(t.requests).toEqual([true]);
    reply.resolve(key());
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(t.u.waiting).toBe(false);
    expect(t.applied.length).toBe(1);
    expect(t.state.unlocked).toBe(true);
  });

  it('a failed interactive request leaves the master password as the fallback', async () => {
    let n = 0;
    const t = setup(() => (n++ === 0 ? Promise.reject({ code: 'timeout', message: '桌面端没有在 2 分钟内解锁' }) : Promise.resolve(key())));
    expect(await t.u.unlock(true)).toBe(false);
    expect(t.u.error).toBe('桌面端没有在 2 分钟内解锁');
    expect(t.u.waiting).toBe(false);
    expect(t.state.unlocked).toBe(false);
    // the next explicit action asks again
    expect(await t.u.unlock(true)).toBe(true);
    expect(t.u.error).toBe('');
    expect(t.requests).toEqual([true, true]);
  });

  it('a master password typed meanwhile wins; the late key is dropped', async () => {
    const reply = later<Uint8Array>();
    const t = setup(() => reply.p);
    const waiting = t.u.unlock(true);
    await flush();
    t.state.unlocked = true; // unlocked with the master password in the popup
    const late = key();
    reply.resolve(late);
    expect(await waiting).toBe(true);
    expect(t.applied).toEqual([]);
    expect([...late].every((b) => b === 0)).toBe(true);
  });

  it('nothing happens without the setting, a pairing, or for another account', async () => {
    for (const change of [
      (t: ReturnType<typeof setup>) => (t.state.enabled = false),
      (t: ReturnType<typeof setup>) => t.setPairing(null),
      (t: ReturnType<typeof setup>) => t.setPairing({ paired: false, accountId: 'acc-1' }),
      (t: ReturnType<typeof setup>) => t.setPairing({ paired: true, accountId: 'acc-2' }),
      (t: ReturnType<typeof setup>) => (t.state.signed_in = false),
    ]) {
      const t = setup(() => Promise.resolve(key()));
      change(t);
      expect(await t.u.unlock(true)).toBe(false);
      expect(t.requests).toEqual([]);
      expect(t.u.error).toBe('');
    }
  });
});

describe('the unlock request', () => {
  function capture() {
    const sent: { msg: Record<string, unknown>; timeout: number }[] = [];
    const port = new DesktopPort(() => ({}) as PortLike, () => {});
    port.request = (msg: Record<string, unknown>, timeout = 10_000) => {
      sent.push({ msg, timeout });
      return Promise.resolve({ type: 'error', code: 'locked', message: 'locked' });
    };
    return { port, sent };
  }

  it('says whether the user asked, and waits long only then', async () => {
    const c = capture();
    const pairing = { id: 'p1', privateKey: {} as CryptoKey, publicKey: new Uint8Array(65), accountId: 'acc-1', serverUrl: 'https://vault.example.com', paired: true };
    await expect(requestAccountKey(c.port, pairing)).rejects.toMatchObject({ code: 'locked' });
    await expect(requestAccountKey(c.port, pairing, true)).rejects.toMatchObject({ code: 'locked' });
    expect(c.sent[0]!.msg.interactive).toBeUndefined();
    expect(c.sent[0]!.timeout).toBe(10_000);
    expect(c.sent[1]!.msg.interactive).toBe(true);
    expect(c.sent[1]!.timeout).toBe(INTERACTIVE_TIMEOUT_MS);
    // longer than the desktop app's own two minutes plus starting it
    expect(INTERACTIVE_TIMEOUT_MS).toBeGreaterThan(150_000);
  });
});
