// Exposes a minimal, safe API to the renderer.
import { contextBridge, ipcRenderer } from 'electron';

type Filter = { name: string; extensions: string[] };

contextBridge.exposeInMainWorld('celerityNative', {
  open: (opts: { filters?: Filter[]; multi?: boolean; title?: string }) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts: { defaultName: string; filters?: Filter[]; title?: string }) => ipcRenderer.invoke('dialog:save', opts),
  chooseDir: (opts: { title?: string }) => ipcRenderer.invoke('dialog:dir', opts),
  write: (file: string, data: Uint8Array | string) => ipcRenderer.invoke('fs:write', file, data),
  writeMany: (dir: string, files: { name: string; data: Uint8Array | string }[]) => ipcRenderer.invoke('fs:writeMany', dir, files),
  read: (file: string) => ipcRenderer.invoke('fs:read', file),
  recent: () => ipcRenderer.invoke('app:recent'),
  setTitle: (t: string) => ipcRenderer.invoke('app:setTitle', t),
  setDirty: (d: boolean) => ipcRenderer.invoke('app:setDirty', d),
  closeNow: () => ipcRenderer.invoke('app:closeNow'),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),
  setMenu: (model: unknown) => ipcRenderer.invoke('app:setMenu', model),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  showItem: (p: string) => ipcRenderer.invoke('app:showItem', p),
  info: () => ipcRenderer.invoke('app:info'),
  media: {
    transcode: (data: Uint8Array, target: string) => ipcRenderer.invoke('media:transcode', data, target),
  },
  video: {
    probe: () => ipcRenderer.invoke('video:probe'),
    start: (o: unknown) => ipcRenderer.invoke('video:start', o),
    frame: (id: number, data: Uint8Array) => ipcRenderer.invoke('video:frame', id, data),
    finish: (id: number) => ipcRenderer.invoke('video:finish', id),
    cancel: (id: number) => ipcRenderer.invoke('video:cancel', id),
  },
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    const allowed = ['app:open-path', 'app:command', 'app:save-and-close'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
