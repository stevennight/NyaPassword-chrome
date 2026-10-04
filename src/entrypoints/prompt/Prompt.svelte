<script lang="ts">
  import { onMount } from 'svelte';
  import Logo from '../../../../common/web/src/components/Logo.svelte';
  import { send, type Context } from '../../lib/rpc';

  const n = new URLSearchParams(location.search).get('n') ?? '';
  let ctx = $state<Context | null>(null);
  let error = $state('');
  let password = $state('');
  let busy = $state(false);
  let vaultId = $state('');
  let target = $state(''); // passkey create: '' = new item, else "vault|item"

  onMount(load);
  async function load() {
    try {
      ctx = await send<Context>({ t: 'ctx:get', n });
      vaultId = ctx.vaults?.[0]?.id ?? '';
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
      vaultId = ctx.vaults?.[0]?.id ?? '';
      password = '';
    } catch (err) {
      error = (err as { code: string }).code === 'wrong_password' ? '主密码不正确' : (err as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  async function act(p: Promise<unknown>) {
    busy = true;
    try {
      await p;
    } catch (e) {
      error = (e as { message: string }).message;
      busy = false;
    }
  }

  const save = () => act(send({ t: 'ctx:save', n, vault_id: vaultId }));
  const never = () => act(send({ t: 'ctx:save', n, never: true }));
  const cancel = (fallback = false) => act(send({ t: 'ctx:cancel', n, fallback }));
  function createPasskey() {
    const [tv, ti] = target ? target.split('|') : [];
    const t = tv && ti ? { vault_id: tv, item_id: ti } : undefined;
    return act(send({ t: 'ctx:passkey', n, choice: { create: true, vault_id: vaultId, target: t } }));
  }
  const usePasskey = (v: string, i: string, p: string) => act(send({ t: 'ctx:passkey', n, choice: { vault_id: v, item_id: i, passkey_id: p } }));
</script>

<div class="box">
  <div class="h"><Logo size={22} /><b class="grow">NyaPassword</b><span class="faint small">{ctx?.host ?? ''}</span></div>
  {#if error}<div class="err">{error}</div>{/if}

  {#if ctx?.locked}
    <p class="small muted">{ctx.kind === 'passkey' ? `${ctx.host} 想使用通行密钥。` : `要保存 ${ctx.host} 的登录信息吗？`}先解锁 NyaPassword：</p>
    <form class="row" onsubmit={unlock}>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="input" type="password" bind:value={password} placeholder="主密码" autofocus />
      <button class="btn primary" disabled={busy || !password}>解锁</button>
    </form>
    <div class="acts">
      {#if ctx.kind === 'passkey'}<button class="btn" onclick={() => cancel(true)}>使用其他设备</button>{/if}
      <button class="btn" onclick={() => cancel()}>取消</button>
    </div>
  {:else if ctx?.kind === 'save'}
    <h3>{ctx.offer === 'update' ? `更新 ${ctx.updateTitle} 的密码？` : `保存 ${ctx.host} 的登录？`}</h3>
    <p class="small muted">用户名：<b>{ctx.username || '（无）'}</b>{ctx.offer === 'update' ? '。旧密码会进入密码历史，可随时找回。' : ''}</p>
    {#if ctx.offer !== 'update' && (ctx.vaults?.length ?? 0) > 1}
      <select class="select" bind:value={vaultId}>{#each ctx.vaults ?? [] as v (v.id)}<option value={v.id}>{v.name}</option>{/each}</select>
    {/if}
    <div class="acts">
      <button class="btn ghost sm" onclick={never}>此网站不再询问</button>
      <span class="spacer"></span>
      <button class="btn" onclick={() => cancel()}>不保存</button>
      <button class="btn primary" disabled={busy} onclick={save}>{ctx.offer === 'update' ? '更新' : '保存'}</button>
    </div>
  {:else if ctx?.kind === 'passkey' && ctx.op === 'create'}
    <h3>在 NyaPassword 中保存通行密钥？</h3>
    <p class="small muted">{ctx.rpId} · {ctx.user}</p>
    <label class="lbl" for="t">保存到</label>
    <select id="t" class="select" bind:value={target}>
      <option value="">新建登录条目</option>
      {#each ctx.logins ?? [] as l (l.item_id)}<option value="{l.vault_id}|{l.item_id}">{l.title} · {l.username}</option>{/each}
    </select>
    <div class="acts">
      <button class="btn ghost sm" onclick={() => cancel(true)}>使用其他设备</button>
      <span class="spacer"></span>
      <button class="btn" onclick={() => cancel()}>取消</button>
      <button class="btn primary" disabled={busy} onclick={createPasskey}>保存</button>
    </div>
  {:else if ctx?.kind === 'passkey'}
    <h3>使用通行密钥登录 {ctx.rpId}</h3>
    <div class="list">
      {#each ctx.passkeys ?? [] as p (p.passkey_id)}
        <button class="opt" disabled={busy} onclick={() => usePasskey(p.vault_id, p.item_id, p.passkey_id)}><b>{p.user_name || p.title}</b><span class="faint small">{p.title}</span></button>
      {:else}
        <p class="small muted">NyaPassword 里没有 {ctx.rpId} 的通行密钥。</p>
      {/each}
    </div>
    <div class="acts">
      <button class="btn ghost sm" onclick={() => cancel(true)}>使用其他设备</button>
      <span class="spacer"></span>
      <button class="btn" onclick={() => cancel()}>取消</button>
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body) { background: transparent; }
  .box { height: 100vh; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
  .h { display: flex; align-items: center; gap: 8px; }
  h3 { margin: 4px 0 0; font-size: 15px; }
  .acts { display: flex; gap: 6px; align-items: center; margin-top: auto; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .opt { display: flex; flex-direction: column; align-items: flex-start; border: 1px solid var(--border); background: var(--surface-2); border-radius: 10px; padding: 8px 10px; text-align: left; }
  .opt:hover { border-color: var(--accent); }
  .err { color: var(--bad); font-size: 12.5px; }
</style>
