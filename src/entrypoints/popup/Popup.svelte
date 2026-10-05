<script lang="ts">
  import { onMount } from 'svelte';
  import type { Bridge } from '$lib/bridge';
  import type { ItemView, LockState } from '$lib/types';
  import { avatar } from '$lib/ui.svelte';
  import { errorText } from '$lib/i18n';
  import TotpCode from '../../../../common/web/src/components/TotpCode.svelte';
  import Logo from '../../../../common/web/src/components/Logo.svelte';
  import { send, type Candidate, type DesktopStatus } from '../../lib/rpc';
  import { vault } from '$lib/vault.svelte';

  let { bridge }: { bridge: Bridge } = $props();
  let lockSt = $state<LockState | null>(null);
  let password = $state('');
  let error = $state('');
  let busy = $state(false);
  let tab = $state<chrome.tabs.Tab | null>(null);
  let here = $state<ItemView[]>([]);
  let q = $state('');
  let results = $state<ItemView[]>([]);
  let open = $state<ItemView | null>(null);
  let generated = $state('');
  let toastText = $state('');
  // extension-only settings (chrome.storage.local)
  let settingsOpen = $state(false);
  let autofillOnLoad = $state(false);
  let lockOnScreenLock = $state(true);
  let neverSave = $state<string[]>([]);
  // unlock with the desktop app (native messaging)
  let desk = $state<DesktopStatus | null>(null);
  let deskBusy = $state(false);
  let deskMsg = $state('');
  /** An interactive request has been waiting a moment: say where to unlock. */
  let deskWaiting = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // "使用前需要验证" items: the master password before filling / copying a secret
  let verifying = $state<{ it: ItemView; action: 'fill' | 'password' | 'totp' } | null>(null);
  let vpw = $state('');
  let vbusy = $state(false);
  let verror = $state('');

  onMount(() => {
    void (async () => {
      vault.bridge = bridge; // TotpCode reads vault.bridge
      tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
      await refresh();
      if (lockSt?.signed_in && !lockSt.unlocked) await unlockWithDesktop();
    })();
    return () => clearInterval(pollTimer);
  });

  const deskStatus = () => send<DesktopStatus>({ t: 'desktop:status' }).catch(() => null);

  /**
   * Opening the popup is an explicit action: a locked desktop app shows its
   * own unlock screen (one not running is started) and the extension unlocks
   * when it does. The master password field stays usable meanwhile.
   */
  async function unlockWithDesktop() {
    desk = await deskStatus();
    if (!desk?.enabled || !desk.paired) return;
    deskBusy = true;
    deskMsg = '';
    // an unlocked desktop app answers at once: no message for that
    const shown = setTimeout(() => (deskWaiting = true), 400);
    try {
      if (await send<boolean>({ t: 'desktop:unlock', interactive: true })) await refresh();
    } catch (err) {
      const x = err as { code: string; message: string };
      deskMsg = `桌面端没有解锁：${x.message}。也可以在这里输入主密码`;
    } finally {
      clearTimeout(shown);
      deskWaiting = false;
      deskBusy = false;
    }
  }

  function toggleDesktop(e: Event) {
    const on = (e.target as HTMLInputElement).checked;
    const done = async (enabled: boolean) => {
      await setOpt('desktopUnlock', enabled);
      if (!enabled) await send({ t: 'desktop:disconnect' }).catch(() => {});
      desk = await deskStatus();
    };
    void done(on);
  }

  async function pair() {
    deskMsg = '';
    try {
      await send<{ code: string }>({ t: 'desktop:pair' });
      desk = await deskStatus();
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        desk = (await deskStatus()) ?? desk;
        if (desk?.pairing?.state !== 'pairing') {
          clearInterval(pollTimer);
          await refresh();
        }
      }, 1000);
    } catch (err) {
      deskMsg = (err as { message: string }).message;
    }
  }

  async function unpair() {
    await send({ t: 'desktop:unpair' }).catch(() => {});
    desk = await deskStatus();
  }

  async function refresh() {
    lockSt = await bridge.lockState();
    here = [];
    if (lockSt.unlocked && tab?.url && /^https?:/.test(tab.url)) {
      const list = await send<Candidate[]>({ t: 'popup:candidates', url: tab.url });
      here = list.map((c) => ({ vault_id: c.vault_id, item_id: c.item_id, title: c.title, subtitle: c.username, has_totp: c.has_totp, reprompt: c.reprompt, template: 'login' }) as ItemView);
    }
  }

  async function unlock(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await bridge.unlock(password);
      password = '';
      await refresh();
    } catch (err) {
      const x = err as { code: string; message: string };
      error = errorText(x.code, x.message);
    } finally {
      busy = false;
    }
  }

  async function fill(it: ItemView, verified = false) {
    if (!tab?.id) return;
    if (it.reprompt && !verified) return ask(it, 'fill');
    const n = await send<number>({ t: 'popup:fill', tabId: tab.id, vault_id: it.vault_id, item_id: it.item_id });
    if (n > 0) window.close();
    else flash('这个页面上没有找到可以填写的登录框');
  }

  function ask(it: ItemView, action: 'fill' | 'password' | 'totp') {
    verifying = { it, action };
    vpw = '';
    verror = '';
  }

  /** The service worker checks the master password for this item; the action then goes ahead once. */
  async function verifyAndRun(e: Event) {
    e.preventDefault();
    if (!verifying || vbusy) return;
    const { it, action } = verifying;
    vbusy = true;
    verror = '';
    try {
      await send({ t: 'popup:verify', vault_id: it.vault_id, item_id: it.item_id, password: vpw });
      vpw = '';
      verifying = null;
      if (action === 'fill') await fill(it, true);
      else await copy(it, action, true);
    } catch (err) {
      const x = err as { code: string; message: string };
      verror = x.code === 'wrong_password' ? '主密码不正确' : x.message;
    } finally {
      vbusy = false;
    }
  }

  async function copy(it: ItemView, what: 'username' | 'password' | 'totp', verified = false) {
    if (it.reprompt && what !== 'username' && !verified) return ask(it, what);
    const text = await send<string>({ t: 'popup:secret', vault_id: it.vault_id, item_id: it.item_id, what }).catch((e) => {
      flash((e as { message: string }).message);
      return null;
    });
    if (text === null) return;
    if (!text) return flash('没有这个字段');
    await bridge.copy(text, what !== 'username');
    flash(what === 'username' ? '已复制用户名' : `已复制${what === 'password' ? '密码' : '验证码'}，90 秒后清除`);
  }

  function flash(t: string) {
    toastText = t;
    setTimeout(() => (toastText = ''), 2200);
  }

  async function search() {
    results = q.trim() ? (await bridge.listItems({ query: q })).slice(0, 30) : [];
  }

  function openVault(hash = '') {
    chrome.tabs.create({ url: chrome.runtime.getURL('/vault.html') + hash });
    window.close();
  }

  async function lock() {
    await bridge.lock();
    await refresh();
  }

  async function openSettings() {
    const s = await chrome.storage.local.get(['autofillOnLoad', 'lockOnScreenLock', 'neverSave']);
    autofillOnLoad = s.autofillOnLoad === true;
    lockOnScreenLock = s.lockOnScreenLock !== false;
    neverSave = (s.neverSave as string[] | undefined) ?? [];
    settingsOpen = !settingsOpen;
    if (settingsOpen) desk = await deskStatus();
  }

  const setOpt = (key: string, value: unknown) => chrome.storage.local.set({ [key]: value });

  async function allowSave(origin: string) {
    neverSave = neverSave.filter((o) => o !== origin);
    await setOpt('neverSave', neverSave);
  }

  function gen() {
    generated = bridge.generate({ kind: 'random', length: 20, upper: true, lower: true, digits: true, symbols: true, avoid_ambiguous: true }).password;
  }
</script>

<div class="pop">
  <header class="row">
    <Logo size={22} /><b>NyaPassword</b><span class="spacer"></span>
    {#if lockSt?.signed_in}<button class="btn ghost sm" onclick={openSettings} title="扩展设置" aria-expanded={settingsOpen}>⚙</button>{/if}
    {#if lockSt?.unlocked}<button class="btn ghost sm" onclick={lock} title="锁定">🔒</button>{/if}
  </header>

  {#if settingsOpen}
    <div class="settings">
      <label class="opt"><input type="checkbox" checked={autofillOnLoad} onchange={(e) => setOpt('autofillOnLoad', (autofillOnLoad = (e.target as HTMLInputElement).checked))} />
        <span>打开页面时自动填写<span class="faint small">只有一个匹配的登录、且是 https 页面时填写用户名和密码</span></span></label>
      <label class="opt"><input type="checkbox" checked={lockOnScreenLock} onchange={(e) => setOpt('lockOnScreenLock', (lockOnScreenLock = (e.target as HTMLInputElement).checked))} />
        <span>电脑锁屏时锁定</span></label>
      {#if neverSave.length}
        <div class="grp">不再询问保存的网站</div>
        {#each neverSave as o (o)}
          <div class="row never"><span class="grow small">{o}</span><button class="btn ghost sm" onclick={() => allowSave(o)}>移除</button></div>
        {/each}
      {/if}
      <label class="opt"><input type="checkbox" checked={desk?.enabled ?? false} onchange={toggleDesktop} />
        <span>由桌面端解锁<span class="faint small">打开弹窗或点输入框里的 NyaPassword 按钮时，由桌面端解锁扩展（桌面端锁定时会弹出它的解锁窗口）；桌面端锁定时扩展也锁定</span></span></label>
      {#if desk?.enabled}
        <div class="desk small">
          <div class="row"><span class="faint">扩展 ID</span><span class="mono grow id">{desk.extensionId}</span>
            <button class="btn ghost sm" onclick={() => navigator.clipboard.writeText(desk!.extensionId).then(() => flash('已复制扩展 ID'))}>复制</button></div>
          <div class="faint">先在桌面端“设置 → 浏览器扩展联动”里填入这个 ID 并开启，再点“与桌面端配对”。</div>
          {#if desk.pairing?.state === 'pairing'}
            <div class="code mono">{desk.pairing.code}</div>
            <div>请在桌面端弹出的窗口中确认同样的数字。</div>
          {:else if desk.paired}
            <div class="row"><span class="grow">已配对{desk.desktopUnlocked === true ? ' · 桌面端已解锁' : desk.desktopUnlocked === false ? ' · 桌面端已锁定' : ''}</span>
              <button class="btn ghost sm" onclick={unpair}>取消配对</button></div>
          {:else}
            <button class="btn sm" onclick={pair}>与桌面端配对</button>
          {/if}
          {#if desk.pairing?.state === 'error'}<div class="banner bad small">配对失败：{desk.pairing.error}</div>{/if}
          {#if desk.error && desk.pairing?.state !== 'pairing'}<div class="faint">{desk.error}</div>{/if}
          {#if deskMsg}<div class="banner bad small">{deskMsg}</div>{/if}
        </div>
      {/if}
      <div class="faint small">自动锁定时间等其他设置在密码库的“设置”里。</div>
    </div>
  {/if}

  {#if !lockSt}
    <div class="center faint">…</div>
  {:else if !lockSt.signed_in}
    <div class="center">
      <p class="muted">还没有登录账户</p>
      <button class="btn primary" onclick={() => openVault()}>登录 / 创建账户</button>
    </div>
  {:else if !lockSt.unlocked}
    <form class="center" onsubmit={unlock}>
      <p class="muted small">{lockSt.login}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" type="password" bind:value={password} placeholder="主密码" autofocus />
      <button class="btn primary wide" disabled={busy || !password}>{busy ? '解锁中…' : '解锁'}</button>
      {#if error}<div class="banner bad small">{error}</div>{/if}
      {#if desk?.enabled && desk.paired}
        {#if deskWaiting}
          <div class="banner small wait">请在 NyaPassword 桌面端完成解锁<span class="faint">（主密码、Windows Hello 或 PIN）；也可以在上面输入主密码</span></div>
        {:else if !deskBusy}
          <button type="button" class="btn ghost sm" onclick={unlockWithDesktop}>用桌面端解锁</button>
        {/if}
        {#if deskMsg}<div class="faint small">{deskMsg}</div>{/if}
      {/if}
    </form>
  {:else}
    {#if verifying}
      <form class="verify" onsubmit={verifyAndRun}>
        <div class="t">🔒 {verifying.it.title}</div>
        <div class="muted small">这个条目设置了“使用前需要验证”。{verifying.action === 'fill' ? '填写' : verifying.action === 'password' ? '复制密码' : '复制验证码'}前，请输入主密码。</div>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="input" type="password" bind:value={vpw} placeholder="主密码" autofocus disabled={vbusy} />
        <div class="row">
          <button type="button" class="btn ghost sm" onclick={() => (verifying = null)}>‹ 返回</button>
          <span class="spacer"></span>
          <button class="btn primary sm" disabled={vbusy || !vpw}>{vbusy ? '验证中…' : '验证'}</button>
        </div>
        {#if verror}<div class="banner bad small">{verror}</div>{/if}
      </form>
    {/if}
    <input class="input" bind:value={q} oninput={search} placeholder="搜索全部条目（支持拼音）" />
    {#if !q}
      <div class="grp">此网站 · {tab?.url ? bridge.displayHost(tab.url) : ''}</div>
      {#each here as it (it.item_id)}
        {@const a = avatar(it.title, it.template)}
        <div class="it">
          <div class="ico" style="background:{a.color}">{a.letter}</div>
          <button class="grow txt" onclick={() => (open = open?.item_id === it.item_id ? null : it)}><div class="t">{it.reprompt ? '🔒 ' : ''}{it.title}</div><div class="s">{it.subtitle}</div></button>
          <button class="btn sm primary" onclick={() => fill(it)}>填写</button>
        </div>
        {#if open?.item_id === it.item_id}
          <div class="acts">
            <button class="btn sm" onclick={() => copy(it, 'username')}>复制用户名</button>
            <button class="btn sm" onclick={() => copy(it, 'password')}>复制密码</button>
            {#if it.has_totp}<button class="btn sm" onclick={() => copy(it, 'totp')}>复制验证码</button>{/if}
          </div>
        {/if}
      {:else}
        <div class="faint small pad">没有保存这个网站的登录</div>
      {/each}
    {:else}
      {#each results as it (it.item_id)}
        {@const a = avatar(it.title, it.template)}
        <div class="it">
          <div class="ico" style="background:{a.color}">{a.letter}</div>
          <div class="grow"><div class="t">{it.reprompt ? '🔒 ' : ''}{it.title}</div><div class="s">{it.subtitle}</div></div>
          <button class="btn sm" onclick={() => copy(it, 'password')}>密码</button>
          {#if it.has_totp}<button class="btn sm" onclick={() => copy(it, 'totp')}>验证码</button>{/if}
        </div>
      {:else}
        <div class="faint small pad">没有匹配的条目</div>
      {/each}
    {/if}
    {#if generated}
      <div class="gen"><span class="mono grow">{generated}</span><button class="btn sm" onclick={async () => { await bridge.copy(generated, true); flash('已复制，90 秒后清除'); }}>复制</button></div>
    {/if}
    <footer class="row">
      <button class="btn ghost sm" onclick={gen}>⚿ 生成密码</button>
      <span class="spacer"></span>
      <button class="btn ghost sm" onclick={() => openVault()}>打开密码库 ↗</button>
    </footer>
  {/if}
  {#if toastText}<div class="toast">{toastText}</div>{/if}
</div>

<style>
  .pop { width: 360px; min-height: 200px; padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
  header { gap: 6px; }
  .center { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px 8px; text-align: center; }
  .wide { width: 100%; justify-content: center; }
  .wait { display: flex; flex-direction: column; gap: 2px; text-align: left; width: 100%; }
  .grp { font-size: 11.5px; color: var(--text-3); font-weight: 600; padding-top: 4px; }
  .it { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 8px; }
  .it:hover { background: var(--surface-2); }
  .it .ico { width: 30px; height: 30px; font-size: 13px; }
  .txt { border: 0; background: none; text-align: left; padding: 0; min-width: 0; }
  .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acts { display: flex; gap: 6px; padding: 0 4px 6px 42px; flex-wrap: wrap; }
  .pad { padding: 6px 4px; }
  .verify { display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); border-radius: 10px; padding: 10px; }
  .gen { display: flex; gap: 8px; align-items: center; background: var(--surface-2); border-radius: 8px; padding: 6px 8px; word-break: break-all; }
  .settings { display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); border-radius: 10px; padding: 10px; }
  .settings .opt { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
  .settings .opt span { display: flex; flex-direction: column; gap: 2px; }
  .never { gap: 6px; word-break: break-all; }
  .desk { display: flex; flex-direction: column; gap: 6px; padding-left: 22px; }
  .desk .id { word-break: break-all; font-size: 11.5px; }
  .desk .code { font-size: 26px; letter-spacing: 5px; text-align: center; background: var(--surface); border-radius: 8px; padding: 4px; }
  footer { border-top: 1px solid var(--border); padding-top: 6px; }
  .toast { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); background: var(--text); color: var(--surface); font-size: 12.5px; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
</style>
