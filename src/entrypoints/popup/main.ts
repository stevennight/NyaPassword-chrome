import { mount } from 'svelte';
import '$lib/theme.css';
import { createBridge } from '../../lib/bridge-ext';
import Popup from './Popup.svelte';

createBridge().then((bridge) => mount(Popup, { target: document.getElementById('app')!, props: { bridge } }));
