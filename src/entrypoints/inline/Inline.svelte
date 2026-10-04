<script lang="ts">
  import { onMount } from 'svelte';
  import { avatar } from '$lib/ui.svelte';
  import Logo from '../../../../common/web/src/components/Logo.svelte';
  import { send, type Context } from '../../lib/rpc';

  const n = new URLSearchParams(location.search).get('n') ?? '';
  let ctx = $state<Context | null>(null);
  let error = $state('');
  let password = $state('');
  let busy = $state(false);

  onMount(load);
  async function load() {
    try {
      ctx = await send<Context>({ t: 'ctx:get', n });
    } catch (e) {
      error = (e as { message: string }).message;
    }
  }

  async function unlock(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      ctx = await send<Context>({ t: 'ctx:unlock', n, password });
      password = '';
    } catch (err) {
      error = (err as { code: string }).code === 'wrong_password' ? '主密码不正确' : (err as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  const pick = (v: string, i: string) => send({ t: 'ctx:fill', n, vault_id: v, item_id: i }).catch((e) => (error = e.message));
  const generate = () => send({ t: 'ctx:generate', n }).catch((e) => (error = e.message));
  const close = () => send({ t: 'ctx:cancel', n });
  const openVault = () => chrome.tabs.create({ url: chrome.runtime.getURL('/vault.html') });
  // card / identity menus list every such item; login menus only this site's
  const template = $derived(ctx?.fieldKind === 'card' ? 'credit_card' : ctx?.fieldKind === 'identity' ? 'identity' : 'login');
  const emptyText = $derived(template === 'credit_card' ? '还没有保存银行卡' : template === 'identity' ? '还没有保存身份信息' : '没有保存这个网站的登录');
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="menu">
  <div class="h"><Logo size={14} /><span class="grow">NyaPassword · {ctx?.host ?? ''}</span><button class="x" onclick={close} aria-label="关闭">✕</button></div>
  {#if error}<div class="err">{error}</div>{/if}
  {#if ctx && ctx.locked}
    <form class="unlock" onsubmit={unlock}>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="password" bind:value={password} placeholder="主密码解锁" autofocus />
      <button disabled={busy || !password}>{busy ? '…' : '解锁'}</button>
    </form>
  {:else if ctx}
    <div class="list">
      {#each ctx.candidates ?? [] as c (c.item_id)}
        {@const a = avatar(c.title, template)}
        <button class="opt" onclick={() => pick(c.vault_id, c.item_id)}>
          <span class="ico" style="background:{a.color}">{a.letter}</span>
          {#if template === 'login'}
            <span class="grow"><span class="t">{c.username || c.title}</span><span class="s">{c.title}{c.has_totp ? ' · 含验证码' : ''}</span></span>
          {:else}
            <span class="grow"><span class="t">{c.title}</span><span class="s">{c.username}</span></span>
          {/if}
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
  .err { color: var(--bad); font-size: 12.5px; padding: 0 10px 6px; }
</style>
