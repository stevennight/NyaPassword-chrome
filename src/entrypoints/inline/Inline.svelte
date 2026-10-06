<script lang="ts">
  import { onMount } from 'svelte';
  import { avatar } from '$lib/ui.svelte';
  import Logo from '../../../../common/web/src/components/Logo.svelte';
  import { send, type Candidate, type Context } from '../../lib/rpc';

  const n = new URLSearchParams(location.search).get('n') ?? '';
  let ctx = $state<Context | null>(null);
  let error = $state('');
  let password = $state('');
  let busy = $state(false);
  /** A "使用前需要验证" item the user picked: the master password first. */
  let verifying = $state<Candidate | null>(null);
  let vpw = $state('');

  let poll: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void load();
    return () => clearTimeout(poll);
  });

  async function load() {
    try {
      show(await send<Context>({ t: 'ctx:get', n }));
    } catch (e) {
      error = (e as { message: string }).message;
    }
  }

  /** While the desktop app is being asked to unlock, look again now and then. */
  function show(view: Context) {
    ctx = view;
    clearTimeout(poll);
    if (view.locked && view.desktop?.waiting) poll = setTimeout(() => void load(), 1500);
  }

  async function askDesktop() {
    error = '';
    try {
      show(await send<Context>({ t: 'ctx:desktop', n }));
    } catch (e) {
      error = (e as { message: string }).message;
    }
  }

  async function unlock(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      show(await send<Context>({ t: 'ctx:unlock', n, password }));
      password = '';
    } catch (err) {
      error = (err as { code: string }).code === 'wrong_password' ? '主密码不正确' : (err as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  function pick(c: Candidate) {
    error = '';
    if (c.reprompt) {
      verifying = c;
      vpw = '';
      return;
    }
    send({ t: 'ctx:fill', n, vault_id: c.vault_id, item_id: c.item_id }).catch((e) => (error = e.message));
  }

  /** The service worker checks the password, then fills this item once. */
  async function verifyAndFill(e: Event) {
    e.preventDefault();
    if (!verifying || busy) return;
    const c = verifying;
    busy = true;
    error = '';
    try {
      await send({ t: 'ctx:verify', n, vault_id: c.vault_id, item_id: c.item_id, password: vpw });
      vpw = '';
      await send({ t: 'ctx:fill', n, vault_id: c.vault_id, item_id: c.item_id });
    } catch (err) {
      error = (err as { code: string }).code === 'wrong_password' ? '主密码不正确' : (err as { message: string }).message;
    } finally {
      busy = false;
    }
  }
  const generate = () => send({ t: 'ctx:generate', n }).catch((e) => (error = e.message));
  const close = () => send({ t: 'ctx:cancel', n });
  const openVault = () => chrome.tabs.create({ url: chrome.runtime.getURL('/vault.html') });
  // card / identity menus list every such item; login menus only this site's
  const template = $derived(ctx?.fieldKind === 'card' ? 'credit_card' : ctx?.fieldKind === 'identity' ? 'identity' : 'login');
  const emptyText = $derived(template === 'credit_card' ? '还没有保存银行卡' : template === 'identity' ? '还没有保存身份信息' : '没有保存这个网站的登录');
</script>

<svelte:window onkeydown={(e) => { if (e.key !== 'Escape') return; if (verifying) { verifying = null; error = ''; } else void close(); }} />

<div class="menu">
  <div class="h"><Logo size={14} /><span class="grow">NyaPassword · {ctx?.host ?? ''}</span><button class="x" onclick={close} aria-label="关闭">✕</button></div>
  {#if error}<div class="err">{error}</div>{/if}
  {#if ctx?.topHost}<div class="warn">⚠ 这个登录框属于嵌入的 <b>{ctx.host}</b>，不是你正在访问的 {ctx.topHost}。确认可信再填写。</div>{/if}
  {#if ctx && ctx.locked}
    {#if ctx.desktop?.waiting}
      <div class="desk">请在 NyaPassword 桌面端完成解锁…<span class="faint">也可以在下面输入主密码</span></div>
    {:else if ctx.desktop?.error}
      <div class="desk">桌面端没有解锁：{ctx.desktop.error}</div>
    {/if}
    <form class="unlock" onsubmit={unlock}>
      <!-- a menu that opened on field focus must not take the focus from the page -->
      <!-- svelte-ignore a11y_autofocus -->
      <input type="password" bind:value={password} placeholder="主密码解锁" autofocus={ctx.explicit} />
      <button disabled={busy || !password}>{busy ? '…' : '解锁'}</button>
    </form>
    {#if ctx.desktop && !ctx.desktop.waiting}
      <div class="foot"><span class="grow"></span><button onclick={askDesktop}>用桌面端解锁</button></div>
    {/if}
  {:else if ctx && verifying}
    <form class="verify" onsubmit={verifyAndFill}>
      <div class="vt">🔒 <b>{verifying.title}</b> 需要验证</div>
      <div class="vs">这个条目设置了“使用前需要验证”，填写前请输入主密码。</div>
      <div class="unlock">
        <!-- svelte-ignore a11y_autofocus -->
        <input type="password" bind:value={vpw} placeholder="主密码" autofocus disabled={busy} />
        <button disabled={busy || !vpw}>{busy ? '…' : '填写'}</button>
      </div>
      <button type="button" class="back" onclick={() => { verifying = null; error = ''; }}>‹ 返回</button>
    </form>
  {:else if ctx}
    <div class="list">
      {#each ctx.candidates ?? [] as c (c.item_id)}
        {@const a = avatar(c.title, template)}
        <button class="opt" onclick={() => pick(c)}>
          <span class="ico" style="background:{a.color}">{a.letter}</span>
          {#if template === 'login'}
            <span class="grow"><span class="t">{c.username || c.title}</span><span class="s">{c.title}{c.has_totp ? ' · 含验证码' : ''}</span></span>
          {:else}
            <span class="grow"><span class="t">{c.title}</span><span class="s">{c.username}</span></span>
          {/if}
          {#if c.reprompt}<span class="lock" title="使用前需要验证">🔒</span>{/if}
          {#if c.passkeys}<span class="badge">passkey</span>{/if}
        </button>
      {:else}
        <div class="empty">{emptyText}</div>
      {/each}
    </div>
    <div class="foot">
      {#if template === 'login' && (ctx.isNew || ctx.fieldKind === 'password')}<button onclick={generate}>⚿ 生成强密码</button>{/if}
      <span class="grow"></span>
      <button onclick={openVault}>打开 NyaPassword</button>
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body) { background: transparent; }
  .menu { height: 100vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .h { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); padding: 7px 10px; }
  .x { border: 0; background: none; color: var(--text-3); cursor: pointer; }
  .list { flex: 1; overflow: auto; padding: 0 6px; }
  .opt { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; padding: 7px 8px; border-radius: 8px; text-align: left; }
  .opt:hover, .opt:focus { background: var(--sel); outline: none; }
  .ico { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12px; flex: none; }
  .t, .s { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 12px; color: var(--text-2); }
  .empty { padding: 18px 8px; color: var(--text-3); font-size: 13px; text-align: center; }
  .foot { display: flex; gap: 6px; border-top: 1px solid var(--border); padding: 6px 8px; }
  .foot button { border: 0; background: none; color: var(--accent); font-size: 12.5px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
  .foot button:hover { background: var(--surface-2); }
  .unlock { display: flex; gap: 6px; padding: 10px; }
  .unlock input { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface-2); min-width: 0; }
  .unlock button { border: 0; background: var(--accent); color: var(--accent-text); border-radius: 8px; padding: 0 14px; font-weight: 600; }
  .warn { font-size: 12px; background: var(--warn-bg, #fff4e0); color: var(--warn, #8a5300); border-radius: 8px; margin: 0 8px 6px; padding: 6px 8px; line-height: 1.4; }
  .err { color: var(--bad); font-size: 12.5px; padding: 0 10px 6px; }
  .desk { font-size: 12.5px; padding: 4px 10px 0; display: flex; flex-direction: column; gap: 2px; }
  .faint { color: var(--text-3); font-size: 11.5px; }
  .lock { font-size: 11px; opacity: .7; }
  .verify { display: flex; flex-direction: column; gap: 4px; padding: 4px 6px; }
  .verify .unlock { padding: 6px 4px; }
  .vt { font-size: 13.5px; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vs { font-size: 12px; color: var(--text-2); padding: 0 4px; }
  .back { align-self: flex-start; border: 0; background: none; color: var(--accent); font-size: 12.5px; cursor: pointer; padding: 4px; }
</style>
