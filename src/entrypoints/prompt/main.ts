import { mount } from 'svelte';
import '$lib/theme.css';
import Prompt from './Prompt.svelte';

export default mount(Prompt, { target: document.getElementById('app')! });
