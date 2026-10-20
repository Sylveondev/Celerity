import { App } from '../ui/app';
import { store } from '../ui/state';

const app = new App();
// handy for debugging from DevTools and for automated UI tests
(window as unknown as { celerity: App; __store: typeof store }).celerity = app;
(window as unknown as { __store: typeof store }).__store = store;
window.addEventListener('DOMContentLoaded', () => {
  const host = document.getElementById('app')!;
  app.start(host);
});
