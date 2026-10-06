// Runs in every frame of web pages (isolated world). Detects login fields,
// shows the NyaPassword button and menu (an extension iframe the page cannot
// read), fills what the service worker sends, offers to save submitted
// logins, and relays passkey requests from the page-world script.
//
// Our elements live in the browser's top layer (a manual popover), so the
// page's stacking contexts, transformed / filtered ancestors and overflow
// cannot hide or clip them; a menu for a field in a subframe is shown by the
// top frame, so the subframe's size cannot clip it either.

import { findForms, findProfiles, formOf, isVisible, profileOf, type LoginForm, type ProfileForm } from '../lib/forms';
import { fillProfile, setValue } from '../lib/fill';
import type { Rect, ToContent } from '../lib/rpc';
import { send } from '../lib/rpc';

const MENU_W = 340;
const MENU_H = 300;
const MENU_MIN_H = 160;
const PROMPT_H = 330;
/** postMessage key of the "where is this frame in the top frame's viewport" question */
const WHERE = 'nyapassword:where';
const HOST_CSS = [
  'all: initial',
  'display: block',
  'position: fixed',
  'inset: 0 auto auto 0',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'width: 0',
  'height: 0',
  'overflow: visible',
  'background: transparent',
  'transform: none',
  'opacity: 1',
  'visibility: visible',
  'z-index: 2147483647',
  'pointer-events: none',
]
  .map((d) => `${d} !important;`)
  .join(' ');
const ICON = `<svg viewBox="0 0 32 32" width="18" height="18"><path d="M6 13 L7.5 4 L13 9.5 Z M26 13 L24.5 4 L19 9.5 Z" fill="#3d63f5"/><rect x="5" y="9" width="22" height="20" rx="7" fill="#3d63f5"/><circle cx="16" cy="17.5" r="3.2" fill="#fff"/><rect x="14.6" y="19" width="2.8" height="5.5" rx="1.2" fill="#fff"/></svg>`;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    let forms: LoginForm[] = [];
    let profiles: ProfileForm[] = [];
    let active: HTMLInputElement | HTMLSelectElement | null = null;
    let signedIn = false;
    let host: HTMLDivElement | null = null;
    let shadow: ShadowRoot | null = null;
    let icon: HTMLButtonElement | null = null;
    // set while we fill: our own focus events must not reopen the menu
    let filling = false;
    let hello: Promise<void> = Promise.resolve();
    let filledAt = 0;
    // `remote`: the menu of a field in a subframe (this is the top frame)
    const frames = new Map<string, { el: HTMLIFrameElement; kind: 'menu' | 'prompt'; opened: number; field?: Element; remote?: boolean }>();
    /** This subframe's menu, shown by the top frame. */
    let remote: { n: string; field: Element } | null = null;

    /**
     * Where our host goes: an open modal dialog (or fullscreen element) makes
     * everything outside it inert, so the host goes inside the topmost one.
     */
    function hostParent(): Element {
      let modal: Element | undefined;
      try {
        modal = [...document.querySelectorAll(':modal')].pop();
      } catch {
        /* no :modal support */
      }
      return modal ?? document.documentElement ?? document.body;
    }

    function ensureHost() {
      if (!host || !shadow) {
        host = document.createElement('div');
        host.setAttribute('data-nyapassword', '');
        host.style.cssText = HOST_CSS;
        if ('showPopover' in host) host.popover = 'manual';
        shadow = host.attachShadow({ mode: 'closed' });
      }
      const parent = hostParent();
      // (moving the host reloads open iframes; it happens only when a modal dialog opened or closed)
      if (host.parentElement !== parent) parent.appendChild(host);
      if (host.popover && !host.matches(':popover-open')) raise();
      return shadow;
    }

    /** Into the top layer, above whatever the page put there since (its dialogs, popovers, fullscreen). */
    function raise() {
      if (!host?.popover || !host.isConnected) return;
      try {
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      } catch {
        // cannot be shown as a popover here: a plain fixed element as before
        host.removeAttribute('popover');
      }
    }

    function rescan() {
      forms = findForms(document);
      profiles = findProfiles(document, forms);
    }

    /** A login form, unless the field is really part of a card / address form (e.g. a CVV taken for a 2FA code). */
    function loginFormOf(el: Element): LoginForm | undefined {
      const f = el instanceof HTMLInputElement ? formOf(el, forms) : undefined;
      if (f && !f.username && !f.password && profileOf(el, profiles)) return undefined;
      return f;
    }

    // ------------------------------------------------------------ button in the field

    /** `moved`: the page scrolled / resized (the host stays where it is). */
    function placeIcon(el: HTMLInputElement | HTMLSelectElement, moved = false) {
      const sh = moved && host?.isConnected && shadow ? shadow : ensureHost();
      if (!icon) {
        icon = document.createElement('button');
        icon.innerHTML = ICON;
        icon.title = 'NyaPassword';
        icon.style.cssText = 'all: initial; position: fixed; width: 22px; height: 22px; display: grid; place-items: center; cursor: pointer; border-radius: 6px; background: transparent; pointer-events: auto;';
        icon.addEventListener('mousedown', (e) => e.preventDefault());
        icon.addEventListener('click', (e) => {
          e.preventDefault();
          // only a real click counts as the user asking (it may bring the desktop app forward)
          if (active && e.isTrusted) void openMenu(active, true);
        });
        sh.appendChild(icon);
      }
      const r = el.getBoundingClientRect();
      icon.style.left = `${r.right - 26}px`;
      icon.style.top = `${r.top + (r.height - 22) / 2}px`;
      icon.style.display = 'grid';
    }

    function hideIcon() {
      if (icon) icon.style.display = 'none';
    }

    // ------------------------------------------------------------ iframes

    function frameUrl(page: string, n: string) {
      return `${browser.runtime.getURL(`/${page}.html` as '/popup.html')}?n=${encodeURIComponent(n)}`;
    }

    function closeFrame(n: string) {
      const f = frames.get(n);
      f?.el.remove();
      frames.delete(n);
      // a subframe's menu: its frame learns that it closed
      if (f?.remote) void send({ t: 'inline:close', n }).catch(() => {});
    }

    function closeMenus() {
      for (const [n, f] of frames) if (f.kind === 'menu') closeFrame(n);
      if (remote) {
        void send({ t: 'inline:close', n: remote.n }).catch(() => {});
        remote = null;
      }
    }

    /** The menu's box for a field at `r` (viewport px): below it, or above when there is more room there. */
    function menuBox(r: Rect) {
      const w = Math.min(MENU_W, innerWidth - 16);
      const below = innerHeight - r.bottom - 14;
      const above = r.top - 14;
      const down = below >= MENU_H || below >= above;
      const h = Math.min(MENU_H, Math.max(down ? below : above, MENU_MIN_H), innerHeight - 16);
      const top = down ? Math.min(r.bottom + 6, innerHeight - h - 8) : Math.max(8, r.top - h - 6);
      const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
      return { left, top: Math.max(8, top), w, h };
    }

    function showMenu(n: string, r: Rect, field?: Element) {
      closeMenus();
      const b = menuBox(r);
      const f = document.createElement('iframe');
      f.src = frameUrl('inline', n);
      f.style.cssText = `all: initial; position: fixed; left: ${b.left}px; top: ${b.top}px; width: ${b.w}px; height: ${b.h}px; border: 0; border-radius: 12px; box-shadow: 0 10px 30px rgba(20,30,60,.22); background: transparent; color-scheme: normal; pointer-events: auto;`;
      f.setAttribute('allowtransparency', 'true');
      ensureHost().appendChild(f);
      raise();
      frames.set(n, { el: f, kind: 'menu', opened: Date.now(), field, remote: !field });
    }

    /** This frame's offset in the top frame's viewport, asked up the chain of parent frames (null: no answer). */
    function whereAmI(): Promise<{ x: number; y: number } | null> {
      if (window === window.top) return Promise.resolve({ x: 0, y: 0 });
      return new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 500);
        ch.port1.onmessage = (e) => {
          clearTimeout(timer);
          ch.port1.close();
          const d = e.data as { x?: unknown; y?: unknown } | null;
          resolve(d && typeof d.x === 'number' && typeof d.y === 'number' && Number.isFinite(d.x) && Number.isFinite(d.y) ? { x: d.x, y: d.y } : null);
        };
        window.parent.postMessage({ [WHERE]: 1 }, '*', [ch.port2]);
      });
    }

    /** The iframe element of a child frame (also inside open shadow roots). */
    function childFrame(win: MessageEventSource): HTMLIFrameElement | HTMLFrameElement | undefined {
      const walk = (root: Document | ShadowRoot): HTMLIFrameElement | HTMLFrameElement | undefined => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if ((el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) && el.contentWindow === win) return el;
          const sr = (el as HTMLElement).shadowRoot;
          const found = sr ? walk(sr) : undefined;
          if (found) return found;
        }
        return undefined;
      };
      return walk(document);
    }

    // a child frame asks where it is: its iframe's content box here, plus where this frame is
    addEventListener('message', (e) => {
      const port = e.ports?.[0];
      if (!port || !e.source || typeof e.data !== 'object' || e.data === null || (e.data as Record<string, unknown>)[WHERE] !== 1) return;
      const fr = childFrame(e.source);
      if (!fr) return;
      const r = fr.getBoundingClientRect();
      const cs = getComputedStyle(fr);
      const x = r.left + fr.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const y = r.top + fr.clientTop + (parseFloat(cs.paddingTop) || 0);
      void whereAmI().then((p) => port.postMessage(p ? { x: p.x + x, y: p.y + y } : null));
    });

    async function openMenu(el: HTMLInputElement | HTMLSelectElement, explicit: boolean) {
      // focusing the field again (e.g. back from the menu) keeps the open menu
      if (!explicit && ([...frames.values()].some((f) => f.kind === 'menu' && f.field === el && f.el.isConnected) || remote?.field === el)) return;
      const form = loginFormOf(el);
      const profile = form ? undefined : profileOf(el, profiles);
      const fieldKind = profile ? profile.kind : form?.otp === el ? 'otp' : form?.username === el ? 'username' : 'password';
      let r: { n: string; count: number; crossSite?: boolean } | null;
      try {
        r = await send<{ n: string; count: number; crossSite?: boolean } | null>({ t: 'inline:open', fieldKind, isNew: !!form?.isNew, explicit });
      } catch {
        return;
      }
      // in a frame of another site the menu only opens when the user asks for it
      if (!r || (!explicit && ((r.count === 0 && !form?.isNew) || r.crossSite))) return;
      closeMenus();
      const rect = el.getBoundingClientRect();
      if (window !== window.top) {
        // a subframe (often a small embedded login box) would clip the menu: the top frame shows it
        const at = await whereAmI();
        if (at) {
          const top: Rect = { left: rect.left + at.x, top: rect.top + at.y, right: rect.right + at.x, bottom: rect.bottom + at.y };
          const shown = await send<boolean>({ t: 'inline:show', n: r.n, rect: top }).catch(() => false);
          if (shown) {
            remote = { n: r.n, field: el };
            return;
          }
        }
      }
      showMenu(r.n, rect, el);
    }

    function openPrompt(n: string) {
      if (frames.has(n)) return;
      const f = document.createElement('iframe');
      f.src = frameUrl('prompt', n);
      f.style.cssText = `all: initial; position: fixed; right: 16px; top: 16px; width: min(380px, calc(100vw - 32px)); height: ${Math.min(PROMPT_H, innerHeight - 32)}px; border: 0; border-radius: 14px; box-shadow: 0 10px 30px rgba(20,30,60,.25); background: transparent; color-scheme: normal; pointer-events: auto;`;
      ensureHost().appendChild(f);
      raise();
      frames.set(n, { el: f, kind: 'prompt', opened: Date.now() });
    }

    /** The click that chose an entry must have been on a visible menu (anti-clickjacking). */
    function menuTrusted(n?: string): boolean {
      if (!n) return true;
      // this subframe's menu in the top frame: the service worker asked the top frame (`menu:trusted`)
      if (remote?.n === n) return true;
      const f = frames.get(n);
      if (!f || !f.el.isConnected) return false;
      if (Date.now() - f.opened < 300) return false;
      const st = getComputedStyle(f.el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 1) return false;
      const host = f.el.getRootNode() instanceof ShadowRoot ? (f.el.getRootNode() as ShadowRoot).host : null;
      if (host && Number(getComputedStyle(host).opacity) < 1) return false;
      // taken out of the top layer by the page
      if (host?.hasAttribute('popover') && !host.matches(':popover-open')) return false;
      return true;
    }

    // ------------------------------------------------------------ fill

    function fill(msg: Extract<ToContent, { t: 'fill' }>) {
      if (!menuTrusted(msg.n)) return;
      rescan();
      if (msg.profile) {
        const p = (active && profileOf(active, profiles)) ?? profiles[0];
        if (!p) return;
        filling = true;
        fillProfile(p, msg.profile);
        filling = false;
        filledAt = Date.now();
        if (msg.n) closeFrame(msg.n);
        closeMenus();
        hideIcon();
        return;
      }
      const form = (active && loginFormOf(active)) ?? forms.find((f) => f.password && !f.isNew) ?? forms[0];
      if (!form) return;
      filling = true;
      if (msg.generated) {
        if (form.password) setValue(form.password, msg.generated);
        if (form.confirm) setValue(form.confirm, msg.generated);
      } else {
        if (form.username && msg.username && isVisible(form.username)) setValue(form.username, msg.username);
        if (form.password && msg.password && isVisible(form.password)) setValue(form.password, msg.password);
        if (form.otp && msg.totp) setValue(form.otp, msg.totp);
      }
      filling = false;
      filledAt = Date.now();
      if (msg.n) closeFrame(msg.n);
      closeMenus();
      hideIcon();
    }

    // ------------------------------------------------------------ save

    let lastCapture = '';
    async function capture(form: LoginForm | undefined) {
      if (!form?.password || !form.password.value) return;
      const username = form.username?.value ?? '';
      const key = `${username}\u0000${form.password.value}`;
      if (key === lastCapture) return;
      lastCapture = key;
      try {
        const r = await send<{ n: string } | null>({ t: 'save:capture', username, password: form.password.value });
        if (r?.n) openPrompt(r.n);
      } catch {
        /* not signed in */
      }
    }

    document.addEventListener(
      'submit',
      (e) => {
        rescan();
        const f = forms.find((x) => (x.root as Element) === e.target || (x.password && (e.target as Element).contains(x.password)));
        void capture(f);
      },
      true,
    );
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element;
        const btn = t.closest?.('button, input[type="submit"], [role="button"], a');
        if (!btn) {
          if (!t.closest?.('[data-nyapassword]') && !(t instanceof HTMLInputElement)) closeMenus();
          return;
        }
        rescan();
        const f = forms.find((x) => x.password && x.password.value && ((x.root as Element).contains?.(btn) || btn.compareDocumentPosition(x.password) & Node.DOCUMENT_POSITION_PRECEDING));
        if (f) void capture(f);
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') closeMenus();
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          rescan();
          const f = formOf(e.target, forms);
          if (f?.password === e.target) void capture(f);
        }
      },
      true,
    );

    // ------------------------------------------------------------ focus

    document.addEventListener(
      'focusin',
      async (e) => {
        const el = e.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || filling) return;
        await hello;
        if (!signedIn) return;
        rescan();
        const form = loginFormOf(el);
        if (!form) {
          const profile = profileOf(el, profiles);
          if (!profile) return hideIcon();
          active = el;
          placeIcon(el);
          // a card / address form opens on its first empty field (only when something can fill it)
          if (el instanceof HTMLInputElement && !el.value && Date.now() - filledAt > 3000) void openMenu(el, false);
          return;
        }
        if (form.confirm === el || !(el instanceof HTMLInputElement)) {
          hideIcon();
          return;
        }
        active = el;
        placeIcon(el);
        // open automatically for the first field of a login form
        if ((el === (form.username ?? form.password) || form.isNew) && Date.now() - filledAt > 3000 && !el.value) void openMenu(el, false);
      },
      true,
    );
    const reposition = () => {
      if (active && icon?.style.display !== 'none' && active.isConnected) placeIcon(active, true);
      closeMenus();
    };
    addEventListener('scroll', reposition, { passive: true, capture: true });
    addEventListener('resize', reposition, { passive: true });

    const mo = new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(rescan, 400);
    });
    let scanTimer: ReturnType<typeof setTimeout>;
    mo.observe(document.documentElement, { childList: true, subtree: true });
    ctx.onInvalidated(() => {
      mo.disconnect();
      host?.remove();
    });

    // ------------------------------------------------------------ passkeys (from the page-world script)

    // requests are relayed by passkey-relay.content.ts (any frame); the
    // service worker asks the top frame to show the prompt

    // ------------------------------------------------------------ from the service worker

    browser.runtime.onMessage.addListener((msg: ToContent, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (msg.t === 'fill') fill(msg);
      if (msg.t === 'close') {
        if (remote?.n === msg.n) remote = null;
        closeFrame(msg.n);
      }
      if (msg.t === 'show:prompt' && window === window.top) {
        openPrompt(msg.n);
        sendResponse(true);
      }
      if (msg.t === 'show:menu' && window === window.top) {
        const r = msg.rect;
        if (![r.left, r.top, r.right, r.bottom].every((v) => typeof v === 'number' && Number.isFinite(v))) return sendResponse(false);
        showMenu(msg.n, r);
        sendResponse(true);
      }
      if (msg.t === 'menu:trusted') sendResponse(frames.get(msg.n)?.remote === true && menuTrusted(msg.n));
      if (msg.t === 'resize') {
        const f = frames.get(msg.n);
        if (f?.kind === 'prompt') f.el.style.height = `${Math.max(120, Math.min(Math.ceil(msg.h), innerHeight - 32))}px`;
      }
    });

    // ------------------------------------------------------------ start

    rescan();
    hello = send<{ signedIn?: boolean; prompt?: string }>({ t: 'hello' })
      .then((r) => {
        signedIn = !!r.signedIn || !!r.prompt;
        if (r.prompt) openPrompt(r.prompt);
        // the service worker decides (setting off by default, exactly one match, https)
        else if (signedIn && forms.some((f) => f.password && !f.isNew)) void send({ t: 'autofill:load' }).catch(() => {});
      })
      .catch(() => {});
  },
});
