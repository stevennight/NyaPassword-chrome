// Isolated world, every frame from document_start, including about:blank and
// blob: frames that inherit a web origin (Google's sign-in challenge issues
// its WebAuthn call from such a frame). Relays the page-world script's
// requests to the service worker; the prompt itself is shown by the content
// script of the tab's top frame, so a hidden frame cannot hide it.

import type { ToContent } from '../lib/rpc';
import { send } from '../lib/rpc';

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  runAt: 'document_start',
  main() {
    // page request id -> context nonce
    const pending = new Map<string, string>();
    const target = location.origin === 'null' ? '*' : location.origin;
    const toPage = (data: Record<string, unknown>) => window.postMessage(data, target);

    window.addEventListener('message', async (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.npw === 'pk-abort') {
        const n = pending.get(e.data.id);
        if (n) {
          pending.delete(e.data.id);
          void send({ t: 'passkey:abort', n }).catch(() => {});
        }
        return;
      }
      if (e.data.npw !== 'pk-req') return;
      const { id, op, request, conditional } = e.data as { id: string; op: 'create' | 'get'; request: string; conditional: boolean };
      toPage({ npw: 'pk-ack', id });
      try {
        const r = await send<{ n?: string; fallback?: boolean }>({ t: 'passkey:begin', op, request, conditional });
        if (r.fallback || !r.n) return toPage({ npw: 'pk-res', id, fallback: true });
        pending.set(id, r.n);
      } catch {
        toPage({ npw: 'pk-res', id, fallback: true });
      }
    });

    browser.runtime.onMessage.addListener((msg: ToContent) => {
      if (msg.t !== 'passkey:result') return;
      for (const [id, n] of pending) {
        if (n !== msg.reqId) continue;
        pending.delete(id);
        toPage({ npw: 'pk-res', id, response: msg.response, error: msg.error, fallback: msg.fallback });
      }
    });
  },
});
