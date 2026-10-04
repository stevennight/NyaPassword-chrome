<script lang="ts">
  import { onMount } from 'svelte';
  import type { Bridge } from '$lib/bridge';
  import type { ItemView, LockState } from '$lib/types';
  import { avatar } from '$lib/ui.svelte';
  import { errorText } from '$lib/i18n';
  import TotpCode from '../../../../common/web/src/components/TotpCode.svelte';
  import Logo from '../../../../common/web/src/components/Logo.svelte';
  import { send, type Candidate } from '../../lib/rpc';
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

  onMount(async () => {
    vault.bridge = bridge; // TotpCode reads vault.bridge
    tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
    await refresh();
  });

  async function refresh() {
    lockSt = await bridge.lockState();
    here = [];
    if (lockSt.unlocked && tab?.url && /^https?:/.test(tab.url)) {
      const list = await send<Candidate[]>({ t: 'popup:candidates', url: tab.url });
      here = list.map((c) => ({ vault_id: c.vault_id, item_id: c.item_id, title: c.title, subtitle: c.username, has_totp: c.has_totp, template: 'login' }) as ItemView);
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

  async function fill(it: ItemView) {
    if (!tab?.id) return;
    const n = await send<number>({ t: 'popup:fill', tabId: tab.id, vault_id: it.vault_id, item_id: it.item_id });
    if (n > 0) window.close();
    else flash('这个页面上没有找到可以填写的登录框');
  }

  async function copy(it: ItemView, what: 'username' | 'password' | 'totp') {
    const full = await bridge.item(it.vault_id, it.item_id);
    const fields = full.content?.fields ?? [];
    let text = '';
    if (what === 'totp') {
      const uri = fields.find((f) => f.kind === 'totp')?.value as string | undefined;
      text = uri ? (bridge.otpCode(uri, Math.floor(Date.now() / 1000))?.code ?? '') : '';
    } else {
      text = String(fields.find((f) => f.purpose === what)?.value ?? '');
    }
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
    </form>
  {:else}
    <input class="input" bind:value={q} oninput={search} placeholder="搜索全部条目（支持拼音）" />
    {#if !q}
      <div class="grp">此网站 · {tab?.url ? bridge.displayHost(tab.url) : ''}</div>
      {#each here as it (it.item_id)}
        {@const a = avatar(it.title, it.template)}
        <div class="it">
          <div class="ico" style="background:{a.color}">{a.letter}</div>
          <button class="grow txt" onclick={() => (open = open?.item_id === it.item_id ? null : it)}><div class="t">{it.title}</div><div class="s">{it.subtitle}</div></button>
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
          <div class="grow"><div class="t">{it.title}</div><div class="s">{it.subtitle}</div></div>
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
  .grp { font-size: 11.5px; color: var(--text-3); font-weight: 600; padding-top: 4px; }
  .it { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 8px; }
  .it:hover { background: var(--surface-2); }
  .it .ico { width: 30px; height: 30px; font-size: 13px; }
  .txt { border: 0; background: none; text-align: left; padding: 0; min-width: 0; }
  .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acts { display: flex; gap: 6px; padding: 0 4px 6px 42px; flex-wrap: wrap; }
  .pad { padding: 6px 4px; }
  .gen { display: flex; gap: 8px; align-items: center; background: var(--surface-2); border-radius: 8px; padding: 6px 8px; word-break: break-all; }
  .settings { display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); border-radius: 10px; padding: 10px; }
  .settings .opt { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
  .settings .opt span { display: flex; flex-direction: column; gap: 2px; }
  .never { gap: 6px; word-break: break-all; }
  footer { border-top: 1px solid var(--border); padding-top: 6px; }
  .toast { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); background: var(--text); color: var(--surface); font-size: 12.5px; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
</style>
