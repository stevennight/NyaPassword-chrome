// The service worker hosts the only client core of the extension (WASM).
// Extension pages (popup, vault page, inline menu, prompts) call it; content
// scripts can only ask for fills and offer saves, and their origin is always
// the one Chrome reports for the sending frame.

import { createBridge, persistReplica, wasmClient } from '$lib/bridge-wasm';
import type { Bridge } from '$lib/bridge';
import * as npw from '../../../common/web/src/wasm/pkg/npw.js';
import type { Candidate, Context, ContentRequest, PageRequest, Reply, ToContent } from '../lib/rpc';
import { b64, unb64 } from '../lib/rpc';

interface Ctx {
  kind: Context['kind'];
  tabId: number;
  frameId: number;
  origin: string;
  url: string;
  created: number;
  fieldKind?: string;
  isNew?: boolean;
  capture?: { username: string; password: string };
  generated?: string;
  passkey?: { op: 'create' | 'get'; request: string; reqId: string };
}

let bridge: Bridge | null = null;
let ready: Promise<Bridge> | null = null;
const contexts = new Map<string, Ctx>();
const pendingPrompt = new Map<number, { n: string; site: string; expires: number }>();
let ws: WebSocket | null = null;
let autoLockMinutes = 10;

const EXT_PAGE = () => chrome.runtime.getURL('');

function core(): Promise<Bridge> {
  if (!ready) {
    ready = (async () => {
      const b = await createBridge({ deviceName: `浏览器扩展 · ${navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome'}`, platform: 'chrome', alwaysRemember: true });
      const s = await chrome.storage.session.get(['ak', 'contexts']);
      if (s.ak) {
        try {
          wasmClient().unlockWithKey(unb64(s.ak as string));
        } catch {
          await chrome.storage.session.remove('ak');
        }
      }
      for (const [k, v] of Object.entries((s.contexts as Record<string, Ctx>) ?? {})) contexts.set(k, v);
      const l = await chrome.storage.local.get('autoLock');
      if (typeof l.autoLock === 'number') autoLockMinutes = l.autoLock;
      bridge = b;
      if ((await b.lockState()).unlocked) onUnlocked();
      return b;
    })();
  }
  return ready;
}

async function saveContexts() {
  const now = Date.now();
  for (const [k, c] of contexts) if (now - c.created > 10 * 60_000) contexts.delete(k);
  await chrome.storage.session.set({ contexts: Object.fromEntries(contexts) });
}

function nonce(): string {
  return crypto.randomUUID();
}

function site(url: string): string {
  try {
    return npw.displayHost(url).split('.').slice(-2).join('.');
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- lock state

async function onUnlocked() {
  const key = wasmClient().quickUnlockKey();
  await chrome.storage.session.set({ ak: b64(key) });
  touch();
  chrome.alarms.create('sync', { periodInMinutes: 5 });
  void connectEvents();
  void doSync();
}

async function doLock(reason = '') {
  console.info('NyaPassword: lock', reason);
  wasmClient().lock();
  await chrome.storage.session.remove('ak');
  chrome.alarms.clear('autolock');
  chrome.alarms.clear('sync');
  ws?.close();
  ws = null;
  await chrome.action.setBadgeText({ text: '' });
}

function touch() {
  chrome.alarms.create('autolock', { delayInMinutes: autoLockMinutes });
}

async function doSync() {
  try {
    const b = await core();
    if (!(await b.lockState()).unlocked) return;
    await b.sync();
    persistReplica();
  } catch {
    /* offline: try again later */
  }
}

async function connectEvents() {
  const b = await core();
  const st = await b.lockState();
  if (!st.unlocked || ws) return;
  try {
    const token = await b.eventsToken();
    const url = new URL('/v1/events', st.server_url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    ws = new WebSocket(url);
    ws.onmessage = () => void doSync();
    ws.onclose = () => {
      ws = null;
    };
  } catch {
    ws = null;
  }
}



// ---------------------------------------------------------------- clipboard

async function clearClipboard() {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: 'clear a copied password from the clipboard' });
    }
    await chrome.runtime.sendMessage({ t: 'offscreen:clear' });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- autofill

async function candidates(url: string): Promise<Candidate[]> {
  const b = await core();
  if (!(await b.lockState()).unlocked) return [];
  const views = wasmClient().autofillCandidates(url) as { vault_id: string; item_id: string; title: string; subtitle: string; has_totp: boolean; passkeys: number }[];
  return views.map((v) => ({ vault_id: v.vault_id, item_id: v.item_id, title: v.title, username: v.subtitle, has_totp: v.has_totp, passkeys: v.passkeys }));
}

async function credentialsFor(url: string, vaultId: string, itemId: string) {
  const list = await candidates(url);
  if (!list.some((c) => c.vault_id === vaultId && c.item_id === itemId)) throw { code: 'forbidden', message: 'this item is not saved for this site' };
  const view = (await (await core()).item(vaultId, itemId)) as { content?: { fields: { kind: string; purpose?: string; value: unknown }[] } };
  const fields = view.content?.fields ?? [];
  const text = (p: string) => {
    const v = fields.find((f) => f.purpose === p)?.value;
    return typeof v === 'string' ? v : '';
  };
  const totpUri = fields.find((f) => f.kind === 'totp' && typeof f.value === 'string' && f.value)?.value as string | undefined;
  const totp = totpUri ? (npw.otpCode(totpUri, Math.floor(Date.now() / 1000)) as { code: string }).code : undefined;
  return { username: text('username'), password: text('password'), totp };
}

async function fillTab(tabId: number, vaultId: string, itemId: string): Promise<number> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  let n = 0;
  for (const f of frames) {
    if (!/^https?:/.test(f.url)) continue;
    try {
      const creds = await credentialsFor(f.url, vaultId, itemId);
      await chrome.tabs.sendMessage(tabId, { t: 'fill', ...creds } satisfies ToContent, { frameId: f.frameId });
      n++;
    } catch {
      /* this frame is another site */
    }
  }
  touch();
  return n;
}


// Badge: how many logins match the active tab.
async function updateBadge(tabId: number, url?: string) {
  if (!url || !/^https?:/.test(url)) return chrome.action.setBadgeText({ tabId, text: '' });
  const n = (await candidates(url)).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#3d63f5' });
  await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
}

// ---------------------------------------------------------------- messages from content scripts

async function fromContent(msg: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  const url = sender.url ?? '';
  const origin = sender.origin ?? new URL(url).origin;
  if (tabId === undefined || !/^https?:/.test(url)) throw { code: 'forbidden', message: 'not a web page' };
  const b = await core();
  const st = await b.lockState();
  switch (msg.t) {
    case 'hello': {
      const p = pendingPrompt.get(tabId);
      if (p && p.expires > Date.now() && p.site === site(url) && sender.frameId === 0) {
        pendingPrompt.delete(tabId);
        return { prompt: p.n };
      }
      return { signedIn: st.signed_in };
    }
    case 'inline:open': {
      if (!st.signed_in) return null;
      const n = nonce();
      contexts.set(n, { kind: 'fill', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), fieldKind: msg.fieldKind, isNew: msg.isNew });
      await saveContexts();
      const count = st.unlocked ? (await candidates(url)).length : -1;
      return { n, count };
    }
    case 'save:capture': {
      if (!st.signed_in || !msg.password) return null;
      const never = ((await chrome.storage.local.get('neverSave')).neverSave as string[] | undefined) ?? [];
      if (never.includes(origin)) return null;
      let offer: 'new' | 'update' | null = 'new';
      if (st.unlocked) {
        const list = await candidates(url);
        for (const c of list) {
          const creds = await credentialsFor(url, c.vault_id, c.item_id).catch(() => null);
          if (!creds) continue;
          if (creds.username === msg.username && creds.password === msg.password) offer = null;
          else if (creds.username === msg.username && offer !== null) offer = 'update';
        }
      }
      if (!offer) return null;
      const n = nonce();
      contexts.set(n, { kind: 'save', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), capture: { username: msg.username, password: msg.password } });
      await saveContexts();
      // the page may navigate away right after submitting: the next page of the site shows it
      pendingPrompt.set(tabId, { n, site: site(url), expires: Date.now() + 30_000 });
      return { n };
    }
    case 'passkey:begin': {
      if (!st.signed_in || msg.conditional) return { fallback: true };
      const n = nonce();
      contexts.set(n, { kind: 'passkey', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), passkey: { op: msg.op, request: msg.request, reqId: n } });
      await saveContexts();
      return { n };
    }
  }
}

// ---------------------------------------------------------------- messages from extension pages

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(EXT_PAGE());
}

async function ctxView(n: string): Promise<Context> {
  const c = contexts.get(n);
  if (!c) throw { code: 'not_found', message: '这个提示已过期' };
  const b = await core();
  const st = await b.lockState();
  const view: Context = { kind: c.kind, origin: c.origin, host: npw.displayHost(c.url), signedIn: st.signed_in, locked: !st.unlocked };
  if (!st.unlocked) return view;
  const vaults = (await b.vaults()).map((v) => ({ id: v.id, name: v.name }));
  if (c.kind === 'fill') Object.assign(view, { fieldKind: c.fieldKind, isNew: c.isNew, candidates: await candidates(c.url) });
  if (c.kind === 'save' && c.capture) {
    const list = await candidates(c.url);
    let updateTitle: string | undefined;
    for (const cand of list) {
      const creds = await credentialsFor(c.url, cand.vault_id, cand.item_id).catch(() => null);
      if (creds?.username === c.capture.username) updateTitle = cand.title;
    }
    Object.assign(view, { offer: updateTitle ? 'update' : 'new', username: c.capture.username, updateTitle, vaults });
  }
  if (c.kind === 'passkey' && c.passkey) {
    const req = JSON.parse(c.passkey.request);
    view.op = c.passkey.op;
    view.rpId = c.passkey.op === 'create' ? req.rp?.id ?? npw.displayHost(c.url) : req.rpId ?? npw.displayHost(c.url);
    view.user = c.passkey.op === 'create' ? req.user?.name : undefined;
    view.vaults = vaults;
    if (c.passkey.op === 'get') view.passkeys = wasmClient().passkeyCandidates({ kind: 'web', origin: c.origin }, c.passkey.request);
    else view.logins = await candidates(c.url);
  }
  return view;
}

async function finishPasskey(c: Ctx, result: Omit<Extract<ToContent, { t: 'passkey:result' }>, 't' | 'reqId'>) {
  await chrome.tabs.sendMessage(c.tabId, { t: 'passkey:result', reqId: c.passkey!.reqId, ...result } satisfies ToContent, { frameId: c.frameId }).catch(() => {});
}

const BINARY_ARGS: Record<string, number[]> = { addAttachment: [4], importPreview: [1] };
const BINARY_RESULT = new Set(['attachment', 'exportVault']);

async function fromPage(msg: PageRequest): Promise<unknown> {
  const b = await core();
  touch();
  switch (msg.t) {
    case 'call': {
      const fn = (b as unknown as Record<string, (...a: unknown[]) => unknown>)[msg.m];
      if (typeof fn !== 'function' || ['copy', 'saveFile'].includes(msg.m)) throw { code: 'invalid', message: `unknown method ${msg.m}` };
      const args = [...msg.a];
      for (const i of BINARY_ARGS[msg.m] ?? []) if (typeof args[i] === 'string') args[i] = unb64(args[i] as string);
      if (msg.m === 'setAutoLock') return;
      let r = await fn.apply(b, args);
      if (BINARY_RESULT.has(msg.m) && r instanceof Uint8Array) r = b64(r);
      if (['unlock', 'register', 'signIn'].includes(msg.m)) await onUnlocked();
      if (msg.m === 'lock') await doLock();
      if (msg.m === 'signOut') await doLock();
      persistReplica();
      return r;
    }
    case 'ctx:get':
      return ctxView(msg.n);
    case 'ctx:unlock': {
      await b.unlock(msg.password);
      await onUnlocked();
      return ctxView(msg.n);
    }
    case 'ctx:fill': {
      const c = contexts.get(msg.n);
      if (!c) throw { code: 'not_found', message: 'expired' };
      const creds = await credentialsFor(c.url, msg.vault_id, msg.item_id);
      await chrome.tabs.sendMessage(c.tabId, { t: 'fill', n: msg.n, ...creds } satisfies ToContent, { frameId: c.frameId });
      return true;
    }
    case 'ctx:generate': {
      const c = contexts.get(msg.n);
      if (!c) throw { code: 'not_found', message: 'expired' };
      const g = npw.generate({ kind: 'random', length: 20, upper: true, lower: true, digits: true, symbols: true, avoid_ambiguous: true }) as { password: string };
      c.generated = g.password;
      await saveContexts();
      await chrome.tabs.sendMessage(c.tabId, { t: 'fill', n: msg.n, generated: g.password } satisfies ToContent, { frameId: c.frameId });
      return true;
    }
    case 'ctx:save': {
      const c = contexts.get(msg.n);
      if (!c?.capture) throw { code: 'not_found', message: 'expired' };
      if (msg.never) {
        const never = ((await chrome.storage.local.get('neverSave')).neverSave as string[] | undefined) ?? [];
        await chrome.storage.local.set({ neverSave: [...new Set([...never, c.origin])] });
      } else {
        await saveCapture(c, msg.vault_id);
      }
      contexts.delete(msg.n);
      await saveContexts();
      await chrome.tabs.sendMessage(c.tabId, { t: 'close', n: msg.n } satisfies ToContent, { frameId: c.frameId }).catch(() => {});
      return true;
    }
    case 'ctx:passkey': {
      const c = contexts.get(msg.n);
      if (!c?.passkey) throw { code: 'not_found', message: 'expired' };
      const caller = { kind: 'web', origin: c.origin };
      try {
        let response: unknown;
        if ('create' in msg.choice) {
          const t = msg.choice.target;
          const created = wasmClient().passkeyCreate(caller, c.passkey.request, t?.vault_id, t?.item_id, msg.choice.vault_id) as { response: unknown };
          response = created.response;
        } else {
          response = wasmClient().passkeyGet(caller, c.passkey.request, msg.choice.vault_id, msg.choice.item_id, msg.choice.passkey_id ?? '');
        }
        persistReplica();
        void doSync();
        await finishPasskey(c, { response });
      } catch (e) {
        const m = String((e as { message?: string }).message ?? e);
        const name = /passkey:(\w+):/.exec(m)?.[1] ?? 'NotAllowedError';
        await finishPasskey(c, { error: { name, message: m.replace(/^.*passkey:\w+:/, '') } });
      }
      contexts.delete(msg.n);
      await saveContexts();
      return true;
    }
    case 'ctx:cancel': {
      const c = contexts.get(msg.n);
      if (c?.passkey) await finishPasskey(c, msg.fallback ? { fallback: true } : { error: { name: 'NotAllowedError', message: 'The user cancelled' } });
      if (c) await chrome.tabs.sendMessage(c.tabId, { t: 'close', n: msg.n } satisfies ToContent, { frameId: c.frameId }).catch(() => {});
      contexts.delete(msg.n);
      await saveContexts();
      return true;
    }
    case 'popup:fill':
      return fillTab(msg.tabId, msg.vault_id, msg.item_id);
    case 'popup:candidates':
      return candidates(msg.url);
  }
}

async function saveCapture(c: Ctx, vaultId?: string) {
  const b = await core();
  const cap = c.capture!;
  const list = await candidates(c.url);
  for (const cand of list) {
    const creds = await credentialsFor(c.url, cand.vault_id, cand.item_id).catch(() => null);
    if (creds?.username === cap.username) {
      const view = await b.item(cand.vault_id, cand.item_id);
      const content = view.content!;
      const pw = content.fields.find((f) => f.purpose === 'password');
      if (pw) pw.value = cap.password;
      await b.saveItem(cand.vault_id, cand.item_id, content);
      void doSync();
      return;
    }
  }
  const content = await b.newItem('login');
  content.title = npw.displayHost(c.url);
  const user = content.fields.find((f) => f.purpose === 'username');
  const pw = content.fields.find((f) => f.purpose === 'password');
  if (user) user.value = cap.username;
  if (pw) pw.value = cap.password;
  content.urls = [{ id: npw.newShortId('u'), url: c.origin, match: 'domain' }];
  const vault = vaultId || (await b.vaults())[0]?.id;
  if (!vault) throw { code: 'invalid', message: 'no vault' };
  await b.saveItem(vault, null, content);
  void doSync();
}


// a page copied a secret: clear the clipboard in 90 s


function registerListeners() {
  chrome.alarms.onAlarm.addListener(async (a) => {
    await core();
    if (a.name === 'autolock') await doLock('idle timeout');
    if (a.name === 'sync') {
      await doSync();
      void connectEvents();
    }
    if (a.name === 'clip') await clearClipboard();
  });

  chrome.idle.onStateChanged.addListener(async (state) => {
    if (state !== 'locked') return;
    const { lockOnScreenLock } = await chrome.storage.local.get('lockOnScreenLock');
    if (lockOnScreenLock === false) return;
    await core();
    await doLock('screen locked');
  });

  chrome.commands.onCommand.addListener(async (cmd) => {
    if (cmd !== 'fill-login') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;
    const list = await candidates(tab.url);
    if (list[0]) await fillTab(tab.id, list[0].vault_id, list[0].item_id);
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const t = await chrome.tabs.get(tabId);
    await updateBadge(tabId, t.url).catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete') void updateBadge(tabId, tab.url).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg: { t: string }, sender, reply: (r: Reply) => void) => {
    if (msg.t?.startsWith('offscreen:')) return false;
    const page = isExtensionPage(sender);
    const run = async () => {
      if (msg.t === 'call' || msg.t.startsWith('ctx:') || msg.t.startsWith('popup:')) {
        if (!page) throw { code: 'forbidden', message: 'not allowed from web pages' };
          return fromPage(msg as PageRequest);
      }
      if (page) throw { code: 'forbidden', message: 'content-script message from an extension page' };
      return fromContent(msg as ContentRequest, sender);
    };
    run()
      .then((v) => reply({ ok: true, v }))
      .catch((e) => reply({ ok: false, e: { code: (e && e.code) || 'invalid', message: (e && e.message) || String(e) } }));
    return true;
  });

  chrome.runtime.onMessage.addListener((msg: { t: string }, sender) => {
    if (msg.t === 'clip:secret' && isExtensionPage(sender)) chrome.alarms.create('clip', { delayInMinutes: 1.5 });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoLock) autoLockMinutes = Number(changes.autoLock.newValue) || 10;
  });
}

export default defineBackground({
  type: 'module',
  main() {
    // listeners must be registered synchronously when the worker starts
    registerListeners();
    void core();
  },
});
