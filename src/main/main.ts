// Electron main process: window management, native dialogs, file I/O and
// video encoding through ffmpeg. All editing happens in the renderer.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions, type FileFilter } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ffmpegArgs } from './ffmpeg-args';

const isMac = process.platform === 'darwin';
interface WinState { dirty: boolean; forceClose: boolean; pending: string[]; loaded: boolean }
const windows = new Map<BrowserWindow, WinState>();
let pendingAtStartup: string[] = [];

const focused = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? [...windows.keys()][0] ?? null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fromEvent = (e: any): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender) ?? focused();

// ---------------- single instance + file associations ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e: unknown, argv: string[]) => {
    const file = argv.find((a: string) => /\.fla$/i.test(a));
    if (file) openPath(file);
    const w = focused();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

app.on('open-file', (e: { preventDefault(): void }, file: string) => {
  e.preventDefault();
  openPath(file);
});

function openPath(file: string) {
  if (!app.isReady()) { pendingAtStartup.push(file); return; }
  // open in an empty untouched window if possible, otherwise a new window
  const w = focused();
  if (w) {
    const st = windows.get(w)!;
    if (st.loaded) w.webContents.send('app:open-path', file); else st.pending.push(file);
    return;
  }
  createWindow([file]);
}

// ---------------- recent files ----------------
const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
function readRecent(): string[] {
  try { return JSON.parse(fs.readFileSync(recentPath(), 'utf8')).filter((p: unknown) => typeof p === 'string'); } catch { return []; }
}
function addRecent(p: string) {
  if (!/\.fla$/i.test(p)) return;
  const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, 12);
  try { fs.mkdirSync(path.dirname(recentPath()), { recursive: true }); fs.writeFileSync(recentPath(), JSON.stringify(list)); } catch { /* ignore */ }
  if (isMac) app.addRecentDocument(p);
}

// ---------------- windows ----------------
function createWindow(open: string[] = []) {
  const prev = focused();
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    x: prev ? prev.getPosition()[0] + 30 : undefined,
    y: prev ? prev.getPosition()[1] + 30 : undefined,
    backgroundColor: '#1e1e1e',
    title: 'Celerity',
    show: false,
    // macOS: native menu bar + inset traffic lights over the in-app title strip
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 8 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const st: WinState = { dirty: false, forceClose: false, pending: [...open], loaded: false };
  windows.set(w, st);
  w.once('ready-to-show', () => w.show());
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.webContents.on('did-finish-load', () => {
    st.loaded = true;
    while (st.pending.length) w.webContents.send('app:open-path', st.pending.shift());
  });
  w.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e: { preventDefault(): void }) => e.preventDefault());
  w.on('close', async (e: { preventDefault(): void }) => {
    if (st.forceClose || !st.dirty) return;
    e.preventDefault();
    const r = await dialog.showMessageBox(w, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save changes to your document before closing?',
      detail: "Your changes will be lost if you don't save them.",
    });
    if (r.response === 0) w.webContents.send('app:save-and-close');
    else if (r.response === 1) { st.forceClose = true; w.close(); }
  });
  w.on('closed', () => { windows.delete(w); });
  return w;
}

interface MenuModel { label?: string; id?: string; accelerator?: string; enabled?: boolean; checked?: boolean; role?: string; separator?: boolean; submenu?: MenuModel[] }
let lastModel: MenuModel[] = [];

function toTemplate(items: MenuModel[], target: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  return items.map((it): MenuItemConstructorOptions => {
    if (it.separator) return { type: 'separator' };
    if (it.role) return { role: it.role as MenuItemConstructorOptions['role'] };
    if (it.submenu) return { label: it.label, submenu: toTemplate(it.submenu, target) };
    return {
      label: it.label,
      enabled: it.enabled !== false,
      type: it.checked !== undefined ? 'checkbox' : 'normal',
      checked: it.checked,
      // shortcuts are handled by the renderer so they keep working while typing in fields
      accelerator: it.accelerator,
      registerAccelerator: false,
      click: () => target()?.webContents.send('app:command', it.id),
    };
  });
}

function buildMenu() {
  if (!isMac) {
    // Windows/Linux use the in-app menu bar (identical layout on every platform)
    Menu.setApplicationMenu(null);
    return;
  }
  const send = (cmd: string) => () => focused()?.webContents.send('app:command', cmd);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+U', registerAccelerator: false, click: send('edit.preferences') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];
  if (lastModel.length) {
    template.push(...toTemplate(lastModel, focused));
  } else {
    template.push(
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
    );
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('app:setMenu', (e, model: MenuModel[]) => {
  if (!isMac) return;
  // only the focused window drives the menu
  if (fromEvent(e) !== focused()) return;
  lastModel = model;
  buildMenu();
});

app.whenReady().then(() => {
  buildMenu();
  const fromArgv = process.argv.slice(1).filter((a) => /\.fla$/i.test(a) && fs.existsSync(a));
  createWindow([...pendingAtStartup, ...fromArgv].slice(0, 1));
  pendingAtStartup = [];
  app.on('activate', () => { if (!windows.size) createWindow(); });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// ---------------- IPC: dialogs & files ----------------
const toFilters = (f?: FileFilter[]) => (f && f.length ? f : [{ name: 'All Files', extensions: ['*'] }]);

ipcMain.handle('dialog:open', async (e, opts: { filters?: FileFilter[]; multi?: boolean; title?: string }) => {
  const win = fromEvent(e);
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: toFilters(opts.filters),
    properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const out = [];
  for (const p of r.filePaths) {
    const data = await fsp.readFile(p);
    out.push({ name: path.basename(p), path: p, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    if (/\.fla$/i.test(p)) addRecent(p);
  }
  return out;
});

ipcMain.handle('dialog:save', async (e, opts: { defaultName: string; filters?: FileFilter[]; title?: string }) => {
  const win = fromEvent(e);
  if (!win) return null;
  const r = await dialog.showSaveDialog(win, {
    title: opts.title,
    defaultPath: opts.defaultName,
    filters: toFilters(opts.filters),
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});

ipcMain.handle('dialog:dir', async (e, opts: { title?: string }) => {
  const win = fromEvent(e);
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title: opts?.title, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('fs:write', async (_e, file: string, data: Uint8Array | string) => {
  const tmp = `${file}.tmp-${process.pid}`;
  // write atomically so a crash never corrupts an existing document
  await fsp.writeFile(tmp, typeof data === 'string' ? data : Buffer.from(data));
  await fsp.rename(tmp, file);
  if (/\.fla$/i.test(file)) addRecent(file);
  return true;
});

ipcMain.handle('fs:writeMany', async (_e, dir: string, files: { name: string; data: Uint8Array | string }[]) => {
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) {
    const target = path.join(dir, path.basename(f.name));
    await fsp.writeFile(target, typeof f.data === 'string' ? f.data : Buffer.from(f.data));
  }
  return true;
});

ipcMain.handle('fs:read', async (_e, file: string) => {
  const data = await fsp.readFile(file);
  if (/\.fla$/i.test(file)) addRecent(file);
  return { name: path.basename(file), path: file, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
});

ipcMain.handle('app:recent', async () => readRecent().filter((p) => fs.existsSync(p)));
ipcMain.handle('app:setTitle', (e, title: string) => { fromEvent(e)?.setTitle(title); });
ipcMain.handle('app:setDirty', (e, d: boolean) => {
  const w = fromEvent(e);
  const st = w ? windows.get(w) : undefined;
  if (!w || !st) return;
  st.dirty = !!d;
  if (isMac) w.setDocumentEdited(st.dirty);
});
ipcMain.handle('app:closeNow', (e) => {
  const w = fromEvent(e);
  const st = w ? windows.get(w) : undefined;
  if (w && st) { st.forceClose = true; w.close(); }
});
ipcMain.handle('app:newWindow', () => { createWindow(); });
ipcMain.handle('app:openExternal', (_e, url: string) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('app:showItem', (_e, p: string) => { shell.showItemInFolder(p); });
ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));

// ---------------- video export via ffmpeg ----------------
function ffmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates: string[] = [];
  try {
    // ffmpeg-static returns null for platforms it has no build for (e.g. Windows on ARM),
    // so also look for the binary next to the package (CI ships the x64 build there).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p: string | null = require('ffmpeg-static');
    if (p) candidates.push(p);
    candidates.push(path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), exe));
  } catch { /* not installed */ }
  for (const c of candidates) {
    const unpacked = c.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

interface Job { proc: ChildProcessWithoutNullStreams; err: string; done: Promise<number>; tmp?: string }
const jobs = new Map<number, Job>();
let jobId = 0;

ipcMain.handle('video:probe', async () => {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-version']);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve({ ok: false }));
      p.on('close', (code) => resolve({ ok: code === 0, version: out.split('\n')[0] }));
    } catch {
      resolve({ ok: false });
    }
  });
});

ipcMain.handle('video:start', async (_e, o: { file: string; width: number; height: number; fps: number; format: string; quality: number; loop?: number; audioData?: Uint8Array }) => {
  // the soundtrack arrives as WAV bytes; ffmpeg reads it from a temp file
  let tmp: string | undefined;
  if (o.audioData && o.audioData.byteLength > 44 && o.format !== 'gif') {
    tmp = path.join(app.getPath('temp'), `celerity-audio-${process.pid}-${Date.now()}.wav`);
    await fsp.writeFile(tmp, Buffer.from(o.audioData.buffer, o.audioData.byteOffset, o.audioData.byteLength));
  }
  const args = ffmpegArgs({ file: o.file, width: o.width, height: o.height, fps: o.fps, format: o.format, quality: o.quality, loop: o.loop, audio: tmp });
  const proc = spawn(ffmpegPath(), args);
  const job: Job = {
    tmp,
    proc,
    err: '',
    done: new Promise((resolve) => {
      proc.on('close', (code) => resolve(code ?? 1));
      proc.on('error', (err) => { job.err += String(err); resolve(1); });
    }),
  };
  proc.stderr.on('data', (d) => { job.err += d; if (job.err.length > 20000) job.err = job.err.slice(-20000); });
  proc.stdin.on('error', () => { /* reported via exit code */ });
  const id = ++jobId;
  jobs.set(id, job);
  return id;
});

ipcMain.handle('video:frame', async (_e, id: number, data: Uint8Array) => {
  const job = jobs.get(id);
  if (!job) throw new Error('Video job not found');
  if (job.proc.exitCode !== null) throw new Error(job.err || 'ffmpeg exited early');
  const ok = job.proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  if (!ok) {
    await new Promise<void>((r) => {
      const done = () => { job.proc.stdin.off('drain', done); job.proc.off('close', done); r(); };
      job.proc.stdin.once('drain', done);
      job.proc.once('close', done);
    });
  }
  return true;
});

ipcMain.handle('video:finish', async (_e, id: number) => {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'Video job not found' };
  job.proc.stdin.end();
  const code = await job.done;
  jobs.delete(id);
  if (job.tmp) fsp.unlink(job.tmp).catch(() => {});
  return code === 0 ? { ok: true } : { ok: false, error: job.err.trim() || `ffmpeg exited with code ${code}` };
});

// Converts media with ffmpeg: video -> FLV (Animate/SWF embedding) or MP4 (preview of FLV), audio -> WAV.
ipcMain.handle('media:transcode', async (_e, data: Uint8Array, target: 'flv' | 'mp4' | 'wav') => {
  const dir = app.getPath('temp');
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const inp = path.join(dir, `celerity-in-${stamp}`);
  const out = path.join(dir, `celerity-out-${stamp}.${target}`);
  await fsp.writeFile(inp, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = target === 'flv'
    ? ['-y', '-hide_banner', '-i', inp, '-an', '-c:v', 'flv1', '-q:v', '3', '-vf', even, '-f', 'flv', out]
    : target === 'mp4'
      ? ['-y', '-hide_banner', '-i', inp, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18', '-vf', even, '-movflags', '+faststart', out]
      : ['-y', '-hide_banner', '-i', inp, '-vn', '-ac', '2', '-c:a', 'pcm_s16le', out];
  let err = '';
  const code = await new Promise<number>((resolve) => {
    const proc = spawn(ffmpegPath(), args);
    proc.stderr.on('data', (d) => { err += d; if (err.length > 40000) err = err.slice(-40000); });
    proc.on('close', (c) => resolve(c ?? 1));
    proc.on('error', (e) => { err += String(e); resolve(1); });
  });
  try {
    const fps = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(err)?.[1];
    if (code !== 0) return { ok: false, error: err.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with code ${code}` };
    const bytes = await fsp.readFile(out);
    return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), fps: fps ? Number(fps) : undefined };
  } finally {
    fsp.unlink(inp).catch(() => {});
    fsp.unlink(out).catch(() => {});
  }
});

ipcMain.handle('video:cancel', async (_e, id: number) => {
  const job = jobs.get(id);
  if (!job) return;
  job.proc.kill('SIGKILL');
  jobs.delete(id);
  if (job.tmp) fsp.unlink(job.tmp).catch(() => {});
});
