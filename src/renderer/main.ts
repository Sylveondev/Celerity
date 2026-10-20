import { App } from '../ui/app';
import { store, setUI, ui } from '../ui/state';
import { importFiles } from '../ui/fileops';
import { audio } from '../ui/audio';
import { video } from '../ui/video';
import * as actions from '../ui/actions';

const app = new App();
// handy for debugging from DevTools and for automated UI tests
const w = window as unknown as Record<string, unknown>;
w.celerity = app;
w.__store = store;
w.__ui = ui;
w.__setUI = setUI;
w.__import = importFiles;
w.__audio = audio;
w.__video = video;
w.__actions = actions;
window.addEventListener('DOMContentLoaded', () => {
  const host = document.getElementById('app')!;
  app.start(host);
});
