// Runs in every frame of web pages (isolated world). Detects login fields,
// shows the NyaPassword button and menu (an extension iframe the page cannot
// read), fills what the service worker sends, offers to save submitted
// logins, and relays passkey requests from the page-world script.

import { findForms, findProfiles, formOf, isVisible, profileOf, type LoginForm, type ProfileForm } from '../lib/forms';
import { fillProfile, setValue } from '../lib/fill';
import type { ToContent } from '../lib/rpc';
import { send } from '../lib/rpc';

const MENU_W = 340;
const MENU_H = 300;
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
    const frames = new Map<string, { el: HTMLIFrameElement; kind: 'menu' | 'prompt'; opened: number }>();

    function ensureHost() {
      if (host?.isConnected && shadow) return shadow;
      host = document.createElement('div');
      host.setAttribute('data-nyapassword', '');
      host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647; width: 0; height: 0; pointer-events: none;';
      shadow = host.attachShadow({ mode: 'closed' });
      (document.documentElement ?? document.body).appendChild(host);
      return shadow;
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

    function placeIcon(el: HTMLInputElement | HTMLSelectElement) {
      const sh = ensureHost();
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
    }

    function closeMenus() {
      for (const [n, f] of frames) if (f.kind === 'menu') closeFrame(n);
    }

    async function openMenu(el: HTMLInputElement | HTMLSelectElement, explicit: boolean) {
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
      const f = document.createElement('iframe');
      f.src = frameUrl('inline', r.n);
      const below = rect.bottom + MENU_H + 8 < innerHeight || rect.top < MENU_H;
      const left = Math.max(8, Math.min(rect.left, innerWidth - MENU_W - 8));
      f.style.cssText = `all: initial; position: fixed; left: ${left}px; top: ${below ? rect.bottom + 6 : rect.top - MENU_H - 6}px; width: ${MENU_W}px; height: ${MENU_H}px; border: 0; border-radius: 12px; box-shadow: 0 10px 30px rgba(20,30,60,.22); background: transparent; color-scheme: normal; pointer-events: auto;`;
      f.setAttribute('allowtransparency', 'true');
      ensureHost().appendChild(f);
      frames.set(r.n, { el: f, kind: 'menu', opened: Date.now() });
    }

    function openPrompt(n: string) {
      const f = document.createElement('iframe');
      f.src = frameUrl('prompt', n);
      f.style.cssText = 'all: initial; position: fixed; right: 16px; top: 16px; width: 380px; height: 330px; border: 0; border-radius: 14px; box-shadow: 0 10px 30px rgba(20,30,60,.25); background: transparent; color-scheme: normal; pointer-events: auto;';
      ensureHost().appendChild(f);
      frames.set(n, { el: f, kind: 'prompt', opened: Date.now() });
    }

    /** The click that chose an entry must have been on a visible menu (anti-clickjacking). */
    function menuTrusted(n?: string): boolean {
      if (!n) return true;
      const f = frames.get(n);
      if (!f || !f.el.isConnected) return false;
      if (Date.now() - f.opened < 300) return false;
      const st = getComputedStyle(f.el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 1) return false;
      const host = f.el.getRootNode() instanceof ShadowRoot ? (f.el.getRootNode() as ShadowRoot).host : null;
      if (host && Number(getComputedStyle(host).opacity) < 1) return false;
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
      if (active && icon?.style.display !== 'none' && active.isConnected) placeIcon(active);
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
      if (msg.t === 'close') closeFrame(msg.n);
      if (msg.t === 'show:prompt' && window === window.top) {
        openPrompt(msg.n);
        sendResponse(true);
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
