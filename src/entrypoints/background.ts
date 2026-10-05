// The service worker hosts the only client core of the extension (WASM).
// Extension pages (popup, vault page, inline menu, prompts) call it; content
// scripts can only ask for fills and offer saves, and their origin is always
// the one Chrome reports for the sending frame.
//
// Items marked "使用前需要验证" (`reprompt`): their secrets go to a page only
// after the user typed the master password in the inline menu, the prompt or
// the popup (`ctx:verify` / `popup:verify`), for that context and item, once
// (src/lib/reprompt.ts). The shortcut and fill on page load skip them.

import { createBridge, persistReplica, wasmClient } from '$lib/bridge-wasm';
import type { Bridge } from '$lib/bridge';
import * as npw from '../../../common/web/src/wasm/pkg/npw.js';
import type { Candidate, Context, ContentRequest, DesktopStatus, PageRequest, Reply, ToContent } from '../lib/rpc';
import { b64, unb64 } from '../lib/rpc';
import { clearPairing, DesktopPort, generatePairingKey, HOST_NAME, loadPairing, pairingCode, rawPublicKey, requestAccountKey, savePairing, type Pairing } from '../lib/desktop-link';
import { DesktopUnlocker } from '../lib/desktop-unlock';
import { consume, grant, loadTarget, saveOffer, shortcutTarget, type Verifiable } from '../lib/reprompt';

interface Ctx extends Verifiable {
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
  /** host of the tab's top page when the frame belongs to another site */
  topHost?: string;
  /** the user clicked the NyaPassword button (the menu may ask the desktop app to unlock) */
  explicit?: boolean;
  /** this menu already asked the desktop app */
  desktopAsked?: boolean;
}

let bridge: Bridge | null = null;
let ready: Promise<Bridge> | null = null;
const contexts = new Map<string, Ctx>();
const pendingPrompt = new Map<number, { n: string; site: string; expires: number }>();
let ws: WebSocket | null = null;
let autoLockMinutes = 10;
/** The popup's verification of a reprompt item (kept in memory only). */
const popupGrant: Verifiable = {};

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

/** Registrable domain (public suffix list), so `a.example.com.cn` and `b.example.com.cn` are one site. */
function site(url: string): string {
  try {
    return npw.siteOf(url);
  } catch {
    return url;
  }
}

/** A frame of another site than the tab's top page (design doc §10.4: warn, never fill by itself). */
function crossSite(sender: chrome.runtime.MessageSender): boolean {
  const top = sender.tab?.url;
  return !!top && !!sender.url && sender.frameId !== 0 && site(top) !== site(sender.url);
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
  // verifications of "使用前需要验证" items end with the session
  delete popupGrant.verified;
  for (const c of contexts.values()) delete c.verified;
  await saveContexts().catch(() => {});
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

// ---------------------------------------------------------------- the desktop app (native messaging)

// The port stays open once used, so the desktop app can tell us when it locks.
const desktop = new DesktopPort(
  () => chrome.runtime.connectNative(HOST_NAME),
  (type) => void onDesktopEvent(type),
  () => chrome.runtime.lastError?.message ?? '',
);
let pairState: DesktopStatus['pairing'] = null;

async function desktopEnabled(): Promise<boolean> {
  const { desktopUnlock: on } = await chrome.storage.local.get('desktopUnlock');
  return on === true && typeof chrome.runtime.connectNative === 'function';
}

async function onDesktopEvent(type: string) {
  const st = await (await core()).lockState();
  if (type === 'locked' && st.unlocked) await doLock('desktop app locked');
  if (type === 'unlocked' && !st.unlocked) await unlocker.unlock(false).catch(() => {});
}

/**
 * Unlocking through the desktop app (src/lib/desktop-unlock.ts): automatic
 * attempts only use an unlocked desktop app; interactive ones (popup opened,
 * NyaPassword button clicked) make a locked one show its unlock screen.
 */
const unlocker = new DesktopUnlocker<Pairing>({
  enabled: desktopEnabled,
  lockState: async () => (await core()).lockState(),
  pairing: () => loadPairing(),
  requestKey: (p, interactive) => requestAccountKey(desktop, p, interactive),
  unlockWithKey: async (key) => {
    wasmClient().unlockWithKey(key);
    await onUnlocked();
  },
});

/** Locked, and the desktop app could unlock us (setting on, paired for this account). */
async function desktopPaired(accountId: string): Promise<boolean> {
  if (!(await desktopEnabled())) return false;
  const p = await loadPairing().catch(() => null);
  return !!p?.paired && p.accountId === accountId;
}

async function desktopPair(): Promise<{ code: string }> {
  if (!(await desktopEnabled())) throw { code: 'invalid', message: '请先打开“由桌面端解锁”' };
  const st = await (await core()).lockState();
  if (!st.signed_in) throw { code: 'not_signed_in', message: '请先登录账户' };
  const kp = await generatePairingKey();
  const pub = await rawPublicKey(kp.publicKey);
  const pairing: Pairing = { id: crypto.randomUUID(), privateKey: kp.privateKey, publicKey: pub, accountId: st.account_id, serverUrl: st.server_url, paired: false };
  await savePairing(pairing);
  const code = await pairingCode(pub);
  pairState = { code, state: 'pairing', error: '' };
  const browser = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';
  // the desktop app answers once the user decided (or after its two-minute timeout)
  void desktop
    .request({ type: 'pair', id: pairing.id, public_key: b64(pub), account_id: st.account_id, server_url: st.server_url, browser }, 150_000)
    .then(async (r) => {
      if (r.type === 'paired') {
        await savePairing({ ...pairing, paired: true });
        pairState = { code, state: 'paired', error: '' };
        await unlocker.unlock(false).catch(() => {});
      } else {
        pairState = { code, state: 'error', error: String(r.message ?? r.code) };
      }
    });
  return { code };
}

async function desktopStatus(): Promise<DesktopStatus> {
  const enabled = await desktopEnabled();
  const p = await loadPairing().catch(() => null);
  let desktopUnlocked: boolean | null = null;
  if (enabled && p?.paired && pairState?.state !== 'pairing') {
    const r = await desktop.request({ type: 'hello' }, 3000);
    if (r.type === 'hello') desktopUnlocked = r.unlocked === true;
  }
  return {
    enabled,
    extensionId: chrome.runtime.id,
    paired: !!p?.paired,
    connected: desktop.connected,
    desktopUnlocked,
    pairing: pairState,
    error: desktopUnlocked === null ? desktop.lastError : '',
    waiting: unlocker.waiting,
    waitError: unlocker.error,
  };
}

async function desktopUnpair() {
  const p = await loadPairing().catch(() => null);
  if (p?.paired && (await desktopEnabled())) await desktop.request({ type: 'unpair', pairing_id: p.id }, 3000);
  await clearPairing();
  desktop.close();
  pairState = null;
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
  const views = wasmClient().autofillCandidates(url) as { vault_id: string; item_id: string; title: string; subtitle: string; has_totp: boolean; passkeys: number; reprompt?: boolean }[];
  return views.map((v) => ({ vault_id: v.vault_id, item_id: v.item_id, title: v.title, username: v.subtitle, has_totp: v.has_totp, passkeys: v.passkeys, reprompt: !!v.reprompt }));
}

/** A fill / copy / passkey of `item` may go ahead in `holder` (a context or the popup); uses up a verification. */
async function requireVerified(holder: Verifiable, item: { vault_id: string; item_id: string; reprompt?: boolean }) {
  const ok = consume(holder, item);
  await saveContexts();
  if (!ok) throw { code: 'reprompt', message: '这个条目需要先验证主密码' };
}

/** Checks the master password (Argon2: slow on purpose) for one item in `holder`. */
async function verifyFor(holder: Verifiable, vaultId: string, itemId: string, password: string) {
  delete holder.verified;
  delete holder.verifiedAt;
  if (!(await (await core()).lockState()).unlocked) throw { code: 'locked', message: '已锁定，请先解锁' };
  try {
    wasmClient().verifyPassword(password);
  } finally {
    touch();
  }
  grant(holder, vaultId, itemId);
  await saveContexts();
}

/** Whether an item is marked "使用前需要验证" (the views carry it, the content is not needed). */
async function isReprompt(vaultId: string, itemId: string): Promise<boolean> {
  const v = await (await core()).item(vaultId, itemId);
  return !!v.reprompt;
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

// ---------------------------------------------------------------- cards and identities

const PROFILE_TEMPLATE: Record<string, string> = { card: 'credit_card', identity: 'identity' };
const isProfile = (fieldKind?: string) => !!fieldKind && fieldKind in PROFILE_TEMPLATE;

/** Card / identity items: not bound to a site, the user picks one in the menu. */
async function profileCandidates(kind: string): Promise<Candidate[]> {
  const b = await core();
  if (!(await b.lockState()).unlocked) return [];
  const list = (await b.listItems({ template: PROFILE_TEMPLATE[kind] })).filter((v) => !v.deleted && !v.archived);
  const out: Candidate[] = [];
  for (const v of list) {
    let subtitle = v.subtitle;
    if (kind === 'card' && !v.reprompt) {
      // show the last four digits so cards can be told apart
      const number = (await b.item(v.vault_id, v.item_id)).content?.fields.find((f) => f.id === 'number')?.value;
      const last4 = typeof number === 'string' ? number.replace(/\D/g, '').slice(-4) : '';
      if (last4) subtitle = [v.subtitle, `•••• ${last4}`].filter(Boolean).join(' · ');
    }
    out.push({ vault_id: v.vault_id, item_id: v.item_id, title: v.title, username: subtitle, has_totp: false, passkeys: 0, reprompt: !!v.reprompt });
  }
  return out;
}

const DOUBLE_SURNAMES = ['欧阳', '司马', '诸葛', '上官', '东方', '皇甫', '尉迟', '公孙', '慕容', '长孙', '宇文', '司徒', '夏侯', '轩辕', '令狐', '端木', '南宫', '西门'];

/** Splits a full name into given / family names (Chinese names: surname first). */
function splitName(full: string): { given: string; family: string } {
  const s = full.trim();
  if (/^[一-鿿·]{2,6}$/u.test(s)) {
    const n = DOUBLE_SURNAMES.some((d) => s.startsWith(d)) && s.length > 2 ? 2 : 1;
    return { family: s.slice(0, n), given: s.slice(n) };
  }
  const parts = s.split(/\s+/);
  if (parts.length < 2) return { given: s, family: '' };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1]! };
}

/** The values of a card / identity item, keyed like `ProfileKey` in forms.ts. */
async function profileValues(kind: string, vaultId: string, itemId: string): Promise<Record<string, string>> {
  const view = await (await core()).item(vaultId, itemId);
  const content = view.content;
  if (!content || content.template !== PROFILE_TEMPLATE[kind]) throw { code: 'forbidden', message: 'not a matching item' };
  const val = (id: string) => content.fields.find((f) => f.id === id)?.value;
  const str = (id: string) => {
    const v = val(id);
    return typeof v === 'string' ? v.trim() : '';
  };
  if (kind === 'card') {
    const [yyyy = '', mm = ''] = str('expiry').split('-');
    return { 'cc-name': str('cardholder'), 'cc-number': str('number').replace(/[\s-]/g, ''), 'cc-exp-month': mm.padStart(2, '0'), 'cc-exp-year': yyyy, 'cc-csc': str('cvv') };
  }
  const a = (val('address') ?? {}) as Record<string, string>;
  const name = splitName(str('full_name'));
  const parts = [a.province, a.city, a.district, a.street].map((x) => (x ?? '').trim()).filter(Boolean);
  const cjk = parts.some((x) => /[一-鿿]/u.test(x));
  return {
    name: str('full_name'),
    'given-name': name.given,
    'family-name': name.family,
    tel: str('phone'),
    email: str('email'),
    organization: str('company'),
    street: (a.street ?? '').trim(),
    'full-address': cjk ? parts.join('') : [...parts].reverse().join(', '),
    province: (a.province ?? '').trim(),
    city: (a.city ?? '').trim(),
    district: (a.district ?? '').trim(),
    'postal-code': (a.postal_code ?? '').trim(),
    country: (a.country ?? '').trim(),
  };
}

/** Card numbers only go to pages the network cannot read. */
function secureContext(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
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
  // about:blank / blob: frames report their inherited web origin (passkeys only)
  const inherited = !/^https?:/.test(sender.url ?? '') && /^https?:\/\//.test(sender.origin ?? '') && (msg.t === 'passkey:begin' || msg.t === 'passkey:abort');
  const url = inherited ? `${sender.origin}/` : (sender.url ?? '');
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
      const cross = crossSite(sender);
      contexts.set(n, { kind: 'fill', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), fieldKind: msg.fieldKind, isNew: msg.isNew, topHost: cross ? npw.displayHost(sender.tab!.url!) : undefined, explicit: msg.explicit === true });
      await saveContexts();
      const count = st.unlocked ? (isProfile(msg.fieldKind) ? await profileCandidates(msg.fieldKind) : await candidates(url)).length : -1;
      return { n, count, crossSite: cross };
    }
    case 'save:capture': {
      if (!st.signed_in || !msg.password) return null;
      const never = ((await chrome.storage.local.get('neverSave')).neverSave as string[] | undefined) ?? [];
      if (never.includes(origin)) return null;
      let offer: 'new' | 'update' | null = 'new';
      if (st.unlocked) {
        // values are compared here only; the page learns nothing about a reprompt item's password
        const saved = [];
        for (const c of await candidates(url)) {
          const creds = await credentialsFor(url, c.vault_id, c.item_id).catch(() => null);
          if (creds) saved.push({ reprompt: c.reprompt, username: creds.username, password: creds.password });
        }
        offer = saveOffer(saved, msg.username, msg.password);
      }
      if (!offer) return null;
      const n = nonce();
      contexts.set(n, { kind: 'save', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), capture: { username: msg.username, password: msg.password } });
      await saveContexts();
      // the page may navigate away right after submitting: the next page of the site shows it
      pendingPrompt.set(tabId, { n, site: site(url), expires: Date.now() + 30_000 });
      return { n };
    }
    case 'autofill:load': {
      // optional (off by default): fill the only matching login when the page loads
      const { autofillOnLoad } = await chrome.storage.local.get('autofillOnLoad');
      if (autofillOnLoad !== true || !st.unlocked || !secureContext(url) || crossSite(sender)) return false;
      const only = loadTarget(await candidates(url));
      if (!only) return false;
      const { username, password } = await credentialsFor(url, only.vault_id, only.item_id);
      await chrome.tabs.sendMessage(tabId, { t: 'fill', username, password } satisfies ToContent, { frameId: sender.frameId ?? 0 });
      return true;
    }
    case 'passkey:begin': {
      if (!st.signed_in || msg.conditional) return { fallback: true };
      const n = nonce();
      contexts.set(n, { kind: 'passkey', tabId, frameId: sender.frameId ?? 0, origin, url, created: Date.now(), passkey: { op: msg.op, request: msg.request, reqId: n } });
      await saveContexts();
      // the prompt goes to the top frame: the requesting frame may be hidden
      void showPromptInTop(tabId, n);
      return { n };
    }
    case 'passkey:abort': {
      const c = contexts.get(msg.n);
      if (!c?.passkey || c.tabId !== tabId || c.frameId !== (sender.frameId ?? 0)) return false;
      contexts.delete(msg.n);
      await saveContexts();
      await chrome.tabs.sendMessage(tabId, { t: 'close', n: msg.n } satisfies ToContent, { frameId: 0 }).catch(() => {});
      return true;
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
  let st = await b.lockState();
  // locked: an unlocked desktop app can unlock us without the master password
  // (not while an interactive request waits: that one answers by itself)
  if (st.signed_in && !st.unlocked && !unlocker.waiting && (await unlocker.unlock(false).catch(() => false))) st = await b.lockState();
  const view: Context = { kind: c.kind, origin: c.origin, host: npw.displayHost(c.url), topHost: c.topHost, signedIn: st.signed_in, locked: !st.unlocked };
  if (!st.unlocked) {
    if (st.signed_in && (await desktopPaired(st.account_id))) {
      // the user clicked the NyaPassword button: ask the desktop app (once per menu);
      // a menu that opened by itself never brings the desktop app forward
      if (c.explicit && !c.desktopAsked && !unlocker.waiting) {
        c.desktopAsked = true;
        await saveContexts();
        void unlocker.unlock(true);
      }
      view.desktop = { waiting: unlocker.waiting, error: unlocker.error };
    }
    return view;
  }
  const vaults = (await b.vaults()).map((v) => ({ id: v.id, name: v.name }));
  if (c.kind === 'fill') Object.assign(view, { fieldKind: c.fieldKind, isNew: c.isNew, candidates: isProfile(c.fieldKind) ? await profileCandidates(c.fieldKind!) : await candidates(c.url) });
  if (c.kind === 'save' && c.capture) {
    const list = await candidates(c.url);
    let updateTitle: string | undefined;
    for (const cand of list) {
      if (cand.reprompt) continue;
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
  await chrome.tabs.sendMessage(c.tabId, { t: 'close', n: c.passkey!.reqId } satisfies ToContent, { frameId: 0 }).catch(() => {});
}

/** Asks the top frame's content script to show a prompt; it may still be loading (document_idle). */
async function showPromptInTop(tabId: number, n: string) {
  for (let i = 0; i < 40; i++) {
    const shown = await chrome.tabs.sendMessage(tabId, { t: 'show:prompt', n } satisfies ToContent, { frameId: 0 }).catch(() => false);
    if (shown === true || !contexts.has(n)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  // no top frame to show it in: let the browser handle the request
  const c = contexts.get(n);
  if (c?.passkey) {
    await finishPasskey(c, { fallback: true });
    contexts.delete(n);
    await saveContexts();
  }
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
    case 'ctx:desktop': {
      // the menu's explicit "用桌面端解锁"
      if (!contexts.has(msg.n)) throw { code: 'not_found', message: 'expired' };
      void unlocker.unlock(true);
      return ctxView(msg.n);
    }
    case 'ctx:verify': {
      // the master password for one item of this menu / prompt ("使用前需要验证")
      const c = contexts.get(msg.n);
      if (!c) throw { code: 'not_found', message: 'expired' };
      await verifyFor(c, msg.vault_id, msg.item_id, msg.password);
      return true;
    }
    case 'ctx:fill': {
      const c = contexts.get(msg.n);
      if (!c) throw { code: 'not_found', message: 'expired' };
      if (isProfile(c.fieldKind)) {
        if (c.fieldKind === 'card' && !secureContext(c.url)) throw { code: 'forbidden', message: '这个页面没有加密（http），不填写银行卡' };
        const choice = (await profileCandidates(c.fieldKind!)).find((x) => x.vault_id === msg.vault_id && x.item_id === msg.item_id);
        if (!choice) throw { code: 'forbidden', message: 'not a matching item' };
        await requireVerified(c, choice);
        const profile = await profileValues(c.fieldKind!, msg.vault_id, msg.item_id);
        await chrome.tabs.sendMessage(c.tabId, { t: 'fill', n: msg.n, profile } satisfies ToContent, { frameId: c.frameId });
        return true;
      }
      const choice = (await candidates(c.url)).find((x) => x.vault_id === msg.vault_id && x.item_id === msg.item_id);
      if (!choice) throw { code: 'forbidden', message: 'this item is not saved for this site' };
      await requireVerified(c, choice);
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
          const choice = msg.choice;
          const offered = (wasmClient().passkeyCandidates(caller, c.passkey.request) as { vault_id: string; item_id: string; passkey_id: string; reprompt?: boolean }[]).find(
            (p) => p.vault_id === choice.vault_id && p.item_id === choice.item_id && p.passkey_id === choice.passkey_id,
          );
          if (offered?.reprompt && !consume(c, offered)) {
            // not answered yet: the prompt asks for the master password and tries again
            await saveContexts();
            throw { code: 'reprompt', message: '这个通行密钥需要先验证主密码' };
          }
          response = wasmClient().passkeyGet(caller, c.passkey.request, choice.vault_id, choice.item_id, choice.passkey_id ?? '');
        }
        persistReplica();
        void doSync();
        await finishPasskey(c, { response });
      } catch (e) {
        if ((e as { code?: string }).code === 'reprompt') throw e;
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
      if (c) await chrome.tabs.sendMessage(c.tabId, { t: 'close', n: msg.n } satisfies ToContent, { frameId: c.passkey ? 0 : c.frameId }).catch(() => {});
      contexts.delete(msg.n);
      await saveContexts();
      return true;
    }
    case 'popup:fill': {
      await requireVerified(popupGrant, { vault_id: msg.vault_id, item_id: msg.item_id, reprompt: await isReprompt(msg.vault_id, msg.item_id) });
      return fillTab(msg.tabId, msg.vault_id, msg.item_id);
    }
    case 'popup:candidates':
      return candidates(msg.url);
    case 'popup:verify':
      await verifyFor(popupGrant, msg.vault_id, msg.item_id, msg.password);
      return true;
    case 'popup:secret': {
      // copying from the popup: the username freely, secrets of a reprompt item after popup:verify
      const view = await b.item(msg.vault_id, msg.item_id);
      if (msg.what !== 'username') await requireVerified(popupGrant, { vault_id: msg.vault_id, item_id: msg.item_id, reprompt: !!view.reprompt });
      const fields = view.content?.fields ?? [];
      if (msg.what === 'totp') {
        const uri = fields.find((f) => f.kind === 'totp' && typeof f.value === 'string' && f.value)?.value as string | undefined;
        return uri ? (npw.otpCode(uri, Math.floor(Date.now() / 1000)) as { code: string }).code : '';
      }
      const v = fields.find((f) => f.purpose === msg.what)?.value;
      return typeof v === 'string' ? v : '';
    }
    case 'desktop:status':
      return desktopStatus();
    case 'desktop:unlock': {
      // interactive: the popup was opened (a locked desktop app shows its unlock screen)
      const interactive = msg.interactive === true;
      const ok = await unlocker.unlock(interactive).catch((e) => {
        throw { code: e?.code ?? 'invalid', message: e?.message ?? String(e) };
      });
      if (!ok && interactive && unlocker.error) throw { code: 'desktop', message: unlocker.error };
      return ok;
    }
    case 'desktop:pair':
      return desktopPair();
    case 'desktop:unpair':
      return desktopUnpair();
    case 'desktop:disconnect':
      desktop.close();
      return true;
  }
}

async function saveCapture(c: Ctx, vaultId?: string) {
  const b = await core();
  const cap = c.capture!;
  const list = await candidates(c.url);
  for (const cand of list) {
    // never changed through a page's form submission (the prompt did not offer it)
    if (cand.reprompt) continue;
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


/** The fill shortcut (Ctrl+Shift+L): the active tab's first match that does not ask for verification. */
async function fillShortcut(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return 0;
  // "使用前需要验证" items are skipped: nobody chose them in an extension UI
  const first = shortcutTarget(await candidates(tab.url));
  return first ? fillTab(tab.id, first.vault_id, first.item_id) : 0;
}

// tests/e2e.mjs runs the shortcut's action from the worker: automated browsers
// do not deliver extension shortcuts. Only code in this worker can reach it.
Object.assign(globalThis, { npwFillShortcut: fillShortcut });

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
    if (cmd === 'fill-login') await fillShortcut();
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
      if (msg.t === 'call' || msg.t.startsWith('ctx:') || msg.t.startsWith('popup:') || msg.t.startsWith('desktop:')) {
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
