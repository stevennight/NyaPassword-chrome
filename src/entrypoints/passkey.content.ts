// Page world: wraps navigator.credentials so NyaPassword can answer WebAuthn
// requests. Requests go to the isolated content script and the service
// worker; the user decides in an extension prompt. "Use another device"
// falls back to the browser's own implementation.

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const creds = navigator.credentials;
    if (!creds || !window.PublicKeyCredential) return;
    const origCreate = creds.create.bind(creds);
    const origGet = creds.get.bind(creds);

    const toB64 = (buf: BufferSource): string => {
      const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const fromB64 = (s: string): ArrayBuffer => {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    };
    const desc = (list?: PublicKeyCredentialDescriptor[]) => (list ?? []).map((d) => ({ type: d.type, id: toB64(d.id), transports: d.transports }));

    function createJson(o: PublicKeyCredentialCreationOptions): string {
      return JSON.stringify({
        rp: o.rp,
        user: { id: toB64(o.user.id), name: o.user.name, displayName: o.user.displayName },
        challenge: toB64(o.challenge),
        pubKeyCredParams: o.pubKeyCredParams,
        timeout: o.timeout,
        excludeCredentials: desc(o.excludeCredentials),
        authenticatorSelection: o.authenticatorSelection,
        attestation: o.attestation,
      });
    }

    function getJson(o: PublicKeyCredentialRequestOptions): string {
      return JSON.stringify({ challenge: toB64(o.challenge), timeout: o.timeout, rpId: o.rpId, allowCredentials: desc(o.allowCredentials), userVerification: o.userVerification });
    }

    let seq = 0;
    function ask(op: 'create' | 'get', request: string, conditional: boolean, signal?: AbortSignal): Promise<{ response?: Record<string, unknown>; error?: { name: string; message: string }; fallback?: boolean }> {
      const id = `${Date.now()}-${++seq}`;
      return new Promise((resolve, reject) => {
        const onMsg = (e: MessageEvent) => {
          if (e.source !== window || !e.data || e.data.npw !== 'pk-res' || e.data.id !== id) return;
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        };
        window.addEventListener('message', onMsg);
        signal?.addEventListener('abort', () => {
          window.removeEventListener('message', onMsg);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
        window.postMessage({ npw: 'pk-req', id, op, request, conditional }, location.origin);
      });
    }

    function own(target: object, props: Record<string, unknown>) {
      for (const [k, v] of Object.entries(props)) Object.defineProperty(target, k, { value: v, enumerable: true, configurable: true });
      return target;
    }

    function toCredential(json: Record<string, unknown>, op: 'create' | 'get'): PublicKeyCredential {
      const r = json.response as Record<string, string | number | string[]>;
      const response =
        op === 'create'
          ? own(Object.create(AuthenticatorAttestationResponse.prototype), {
              clientDataJSON: fromB64(r.clientDataJSON as string),
              attestationObject: fromB64(r.attestationObject as string),
              getTransports: () => (r.transports as string[]) ?? ['internal', 'hybrid'],
              getAuthenticatorData: () => fromB64(r.authenticatorData as string),
              getPublicKey: () => fromB64(r.publicKey as string),
              getPublicKeyAlgorithm: () => (r.publicKeyAlgorithm as number) ?? -7,
            })
          : own(Object.create(AuthenticatorAssertionResponse.prototype), {
              clientDataJSON: fromB64(r.clientDataJSON as string),
              authenticatorData: fromB64(r.authenticatorData as string),
              signature: fromB64(r.signature as string),
              userHandle: r.userHandle ? fromB64(r.userHandle as string) : null,
            });
      const ext = (json.clientExtensionResults as Record<string, unknown>) ?? {};
      return own(Object.create(PublicKeyCredential.prototype), {
        id: json.id,
        rawId: fromB64(json.rawId as string),
        type: 'public-key',
        authenticatorAttachment: json.authenticatorAttachment ?? 'platform',
        response,
        getClientExtensionResults: () => ext,
        toJSON: () => json,
      }) as PublicKeyCredential;
    }

    creds.create = async function (options?: CredentialCreationOptions) {
      if (!options?.publicKey) return origCreate(options);
      const r = await ask('create', createJson(options.publicKey), false, options.signal);
      if (r.fallback) return origCreate(options);
      if (r.error) throw new DOMException(r.error.message, r.error.name);
      return toCredential(r.response!, 'create');
    };

    creds.get = async function (options?: CredentialRequestOptions) {
      if (!options?.publicKey) return origGet(options);
      const conditional = (options as { mediation?: string }).mediation === 'conditional';
      const r = await ask('get', getJson(options.publicKey), conditional, options.signal);
      if (r.fallback) return origGet(options);
      if (r.error) throw new DOMException(r.error.message, r.error.name);
      return toCredential(r.response!, 'get');
    };

    // sites offer passkeys only when a platform authenticator is available
    const pkc = window.PublicKeyCredential as unknown as { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> };
    pkc.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
  },
});
