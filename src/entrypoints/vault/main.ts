// The full vault in a tab: the shared web UI with the extension bridge.
import { mount } from 'svelte';
import '$lib/theme.css';
import { createBridge } from '../../lib/bridge-ext';
import { vault } from '$lib/vault.svelte';
import App from '../../../../common/web/src/apps/vault/App.svelte';

const app = mount(App, { target: document.getElementById('app')! });
createBridge().then((b) => vault.init(b));
export default app;
