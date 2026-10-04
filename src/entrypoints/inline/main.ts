import { mount } from 'svelte';
import '$lib/theme.css';
import Inline from './Inline.svelte';

export default mount(Inline, { target: document.getElementById('app')! });
