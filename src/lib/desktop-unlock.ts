// When the extension unlocks through the desktop app (design doc §4.5):
//
// - Automatically (an inline menu that opened by itself, a page load, the
//   desktop app saying "unlocked"): only if the desktop app is unlocked
//   already. A locked desktop app answers `locked` and nothing pops up.
// - After an explicit action (opening the popup, clicking the NyaPassword
//   button in a field or the menu's "用桌面端解锁"): an *interactive* request.
//   The desktop app brings its own unlock screen to the front (master
//   password, Windows Hello or PIN) and answers once the user unlocked it
//   (or after two minutes); a desktop app that is not running is started by
//   its native messaging host. One such request at a time; meanwhile the
//   popup / menu says "请在 NyaPassword 桌面端完成解锁" and keeps the master
//   password field as the fallback.
//
// No pairing, another account, the setting off: nothing happens, the master
// password is the way (as without a desktop app).

export interface UnlockPairing {
  paired: boolean;
  accountId: string;
}

export interface UnlockDeps<P extends UnlockPairing> {
  /** The setting is on and the nativeMessaging permission granted. */
  enabled(): Promise<boolean>;
  lockState(): Promise<{ signed_in: boolean; unlocked: boolean; account_id: string }>;
  pairing(): Promise<P | null>;
  /** The account key from the desktop app; rejects with `{code, message}`. */
  requestKey(pairing: P, interactive: boolean): Promise<Uint8Array>;
  /** Unlocks the extension's core with the key (and starts its unlocked state). */
  unlockWithKey(key: Uint8Array): Promise<void>;
}

/** How long the extension waits for an interactive request (the desktop app gives up after 2 minutes; starting it takes up to 30 s more). */
export const INTERACTIVE_TIMEOUT_MS = 170_000;

export class DesktopUnlocker<P extends UnlockPairing> {
  private pending: Promise<boolean> | null = null;
  /** Why the last interactive request failed (empty: it did not). */
  error = '';

  constructor(private d: UnlockDeps<P>) {}

  /** An interactive request is waiting for the user to unlock the desktop app. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /**
   * Unlocks through the desktop app; whether the extension is unlocked
   * afterwards. Automatic (`interactive` false) requests never wait and never
   * fail loudly for a locked desktop app; other failures reject. Interactive
   * requests are shared while one is pending and never reject: the reason is
   * in `error`.
   */
  unlock(interactive: boolean): Promise<boolean> {
    if (!interactive) return this.run(false);
    if (!this.pending) {
      this.error = '';
      this.pending = this.run(true)
        .catch((e: { code?: string; message?: string }) => {
          this.error = e?.message || e?.code || String(e);
          return false;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  private async run(interactive: boolean): Promise<boolean> {
    if (!(await this.d.enabled())) return false;
    const st = await this.d.lockState();
    if (!st.signed_in) return false;
    if (st.unlocked) return true;
    const p = await this.d.pairing();
    if (!p?.paired || p.accountId !== st.account_id) return false;
    let key: Uint8Array;
    try {
      key = await this.d.requestKey(p, interactive);
    } catch (e) {
      if (!interactive && (e as { code?: string })?.code === 'locked') return false;
      throw e;
    }
    try {
      // the user may have typed the master password here meanwhile
      if ((await this.d.lockState()).unlocked) return true;
      await this.d.unlockWithKey(key);
    } finally {
      key.fill(0);
    }
    return true;
  }
}
