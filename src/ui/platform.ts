// Platform abstraction: Electron (native dialogs, ffmpeg) or plain browser.

export interface Filter { name: string; extensions: string[] }
export interface OpenedFile { name: string; path: string | null; data: Uint8Array }

interface NativeApi {
  open(o: { filters?: Filter[]; multi?: boolean; title?: string }): Promise<OpenedFile[] | null>;
  saveDialog(o: { defaultName: string; filters?: Filter[]; title?: string }): Promise<string | null>;
  chooseDir(o: { title?: string }): Promise<string | null>;
  write(file: string, data: Uint8Array | string): Promise<boolean>;
  writeMany(dir: string, files: { name: string; data: Uint8Array | string }[]): Promise<boolean>;
  read(file: string): Promise<OpenedFile>;
  recent(): Promise<string[]>;
  setTitle(t: string): Promise<void>;
  setDirty(d: boolean): Promise<void>;
  closeNow(): Promise<void>;
  newWindow(): Promise<void>;
  setMenu(model: unknown): Promise<void>;
  openExternal(url: string): Promise<void>;
  showItem(p: string): Promise<void>;
  info(): Promise<{ platform: string; version: string }>;
  media: {
    transcode(data: Uint8Array, target: 'flv' | 'mp4' | 'wav'): Promise<{ ok: boolean; bytes?: Uint8Array; fps?: number; error?: string }>;
  };
  video: {
    probe(): Promise<{ ok: boolean; version?: string }>;
    start(o: { file: string; width: number; height: number; fps: number; format: string; quality: number; loop?: number; audioData?: Uint8Array }): Promise<number>;
    frame(id: number, data: Uint8Array): Promise<boolean>;
    finish(id: number): Promise<{ ok: boolean; error?: string }>;
    cancel(id: number): Promise<void>;
  };
  on(channel: string, fn: (...args: unknown[]) => void): void;
}

declare global {
  interface Window { celerityNative?: NativeApi }
}

export const native: NativeApi | null = typeof window !== 'undefined' ? window.celerityNative ?? null : null;
export const isElectron = !!native;
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function pickFiles(filters: Filter[] | undefined, multi: boolean): Promise<OpenedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multi;
    if (filters && filters.length) input.accept = filters.flatMap((f) => f.extensions.map((e) => (e === '*' ? '' : '.' + e))).filter(Boolean).join(',');
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    input.onchange = async () => {
      settled = true;
      const files = [...(input.files ?? [])];
      input.remove();
      if (!files.length) { resolve(null); return; }
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) }))));
    };
    window.addEventListener('focus', () => setTimeout(() => { if (!settled) { input.remove(); resolve(null); } }, 1000), { once: true });
    input.click();
  });
}

function download(name: string, data: Uint8Array | string, mime = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const platform = {
  async openFiles(filters: Filter[], multi = false, title?: string): Promise<OpenedFile[] | null> {
    if (native) return native.open({ filters, multi, title });
    return pickFiles(filters, multi);
  },

  /** Asks for a destination and writes data. Returns the path (or name in browser). */
  async saveAs(defaultName: string, filters: Filter[], data: Uint8Array | string | (() => Promise<Uint8Array | string>), title?: string): Promise<string | null> {
    if (native) {
      const file = await native.saveDialog({ defaultName, filters, title });
      if (!file) return null;
      const bytes = typeof data === 'function' ? await data() : data;
      await native.write(file, bytes);
      return file;
    }
    const bytes = typeof data === 'function' ? await data() : data;
    download(defaultName, bytes);
    return defaultName;
  },

  /** Asks for a destination path only (Electron) — browser returns the name. */
  async chooseSavePath(defaultName: string, filters: Filter[], title?: string): Promise<string | null> {
    if (native) return native.saveDialog({ defaultName, filters, title });
    return defaultName;
  },

  async writeTo(path: string, data: Uint8Array | string) {
    if (native) { await native.write(path, data); return; }
    download(path.split(/[\\/]/).pop() || 'file', data);
  },

  /** Writes several files next to `mainPath` (or downloads them). */
  async writeSiblings(mainPath: string, files: { name: string; data: Uint8Array | string }[]) {
    if (native) {
      const dir = mainPath.replace(/[\\/][^\\/]*$/, '');
      await native.writeMany(dir, files);
      return;
    }
    for (const f of files) download(f.name, f.data);
  },

  async chooseDir(title?: string): Promise<string | null> {
    if (native) return native.chooseDir({ title });
    return '';
  },

  async writeMany(dir: string, files: { name: string; data: Uint8Array | string }[]) {
    if (native) { await native.writeMany(dir, files); return; }
    for (const f of files) download(f.name, f.data);
  },

  async read(path: string): Promise<OpenedFile | null> {
    if (!native) return null;
    return native.read(path);
  },

  recent: async (): Promise<string[]> => (native ? native.recent() : []),
  setTitle: (t: string) => { if (native) native.setTitle(t); else document.title = t; },
  setDirty: (d: boolean) => { native?.setDirty(d); },
  closeNow: () => native?.closeNow(),
  newWindow: () => { if (native) native.newWindow(); else window.open(location.href, '_blank'); },
  setMenu: (model: unknown) => { native?.setMenu(model); },
  openExternal: (url: string) => { if (native) native.openExternal(url); else window.open(url, '_blank', 'noopener'); },
  showItem: (p: string) => native?.showItem(p),
  video: native?.video ?? null,
  media: native?.media ?? null,
  on: (channel: string, fn: (...args: unknown[]) => void) => native?.on(channel, fn),
  basename: (p: string) => p.split(/[\\/]/).pop() || p,
};
