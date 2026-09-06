import { createApp } from 'vue';
import App from './App.vue';
import './index.css';

// shadcn-vue themes via a `.dark` class. The add-on runs in an iframe and
// cannot read Home Assistant's theme, so follow the OS colour scheme.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

createApp(App).mount('#app');
