// Bridge for extension pages (vault tab, popup): vault operations run in the
// service worker; pure helpers (TOTP, generator, templates) run here on the
// same WASM module.

import init, * as npw from '../../../common/web/src/wasm/pkg/npw.js';
import type { Bridge } from '$lib/bridge';
import { locale } from '$lib/i18n';
import type { Recipe } from '$lib/types';
import { b64, send, unb64 } from './rpc';

const call = <T>(m: string, ...a: unknown[]) => send<T>({ t: 'call', m, a });

export async function createBridge(): Promise<Bridge> {
  await init();
  const asyncMethods = [
    'lockState', 'register', 'signIn', 'unlock', 'lock', 'signOut', 'emergencyKit', 'sync', 'eventsToken', 'vaults', 'createVault', 'renameVault',
    'listItems', 'item', 'tags', 'newItem', 'saveItem', 'deleteItem', 'restoreItem', 'resolveConflict', 'attention', 'itemHistory', 'itemRevision',
    'restoreRevision', 'purge', 'removeAttachment', 'importCommit', 'importBatches', 'undoImport', 'securityReport', 'healthCheck', 'changePassword',
    'devices', 'revokeDevice', 'auditLog',
  ] as const;
  const b: Record<string, unknown> = {};
  for (const m of asyncMethods) b[m] = (...a: unknown[]) => call(m, ...a);

  const bridge = {
    ...b,
    kind: 'web' as const,
    defaultServer: () => '',
    quickUnlockStatus: async () => ({ available: false, enabled: false, label: '' }),
    setQuickUnlock: async () => {
      throw { code: 'invalid', message: '扩展不支持生物识别解锁（可在桌面端开启）' };
    },
    quickUnlock: async () => {
      throw { code: 'invalid', message: '扩展不支持生物识别解锁' };
    },
    addAttachment: (v: string, i: string, name: string, mime: string, data: Uint8Array) => call<string>('addAttachment', v, i, name, mime, b64(data)),
    attachment: async (v: string, i: string, a: string) => unb64(await call<string>('attachment', v, i, a)),
    importPreview: (name: string, data: Uint8Array, password?: string) => call('importPreview', name, b64(data), password),
    exportVault: async (format: string, password: string) => unb64(await call<string>('exportVault', format, password)),
    otpCode: (uri: string, t: number) => {
      try {
        return npw.otpCode(uri, t);
      } catch {
        return null;
      }
    },
    generate: (r: Recipe) => npw.generate(r),
    passwordStrength: (pw: string) => npw.passwordStrength(pw),
    templates: () => npw.templates(locale()),
    fieldPresets: () => npw.fieldPresets(locale()),
    newShortId: (p: string) => npw.newShortId(p),
    displayHost: (u: string) => npw.displayHost(u),
    normalizeSecretKey: (t: string) => npw.normalizeSecretKey(t),
    copy: async (text: string, secret: boolean) => {
      await navigator.clipboard.writeText(text);
      if (secret) chrome.runtime.sendMessage({ t: 'clip:secret' }).catch(() => {});
    },
    saveFile: async (name: string, data: Uint8Array, mime: string) => {
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
  return bridge as unknown as Bridge;
}
