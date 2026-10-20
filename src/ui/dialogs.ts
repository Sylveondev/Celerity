// Modal dialogs.
import { h } from './dom';

export interface DialogButton { label: string; primary?: boolean; danger?: boolean; onClick?: () => boolean | void | Promise<boolean | void> }

export interface Modal { root: HTMLElement; close(): void; body: HTMLElement; setBusy(b: boolean): void }

let openCount = 0;
export function isModalOpen() { return openCount > 0; }

export function modal(opts: { title: string; body: HTMLElement | HTMLElement[]; buttons?: DialogButton[]; width?: number; onClose?: () => void; className?: string }): Modal {
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: `modal ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
  if (opts.width) box.style.width = `min(${opts.width}px, calc(100vw - 32px))`;
  const head = h('div', { class: 'modal-head' }, h('span', null, opts.title));
  const closeBtn = h('button', { class: 'icon-btn modal-x', title: 'Close', html: '&times;' });
  head.append(closeBtn);
  const body = h('div', { class: 'modal-body' });
  for (const b of Array.isArray(opts.body) ? opts.body : [opts.body]) body.append(b);
  const foot = h('div', { class: 'modal-foot' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const buttons = opts.buttons ?? [{ label: 'OK', primary: true }];
  let busy = false;
  const btnEls: HTMLButtonElement[] = [];
  for (const b of buttons) {
    const el = h('button', { class: b.primary ? 'primary' : b.danger ? 'danger' : '' }, b.label) as HTMLButtonElement;
    el.addEventListener('click', async () => {
      if (busy) return;
      const r = b.onClick ? await b.onClick() : undefined;
      if (r !== false) close();
    });
    btnEls.push(el);
    foot.append(el);
  }
  const onKey = (e: KeyboardEvent) => {
    if (!overlay.isConnected) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      const idx = buttons.findIndex((b) => b.primary);
      if (idx >= 0) { e.preventDefault(); e.stopPropagation(); (e.target as HTMLElement)?.blur?.(); setTimeout(() => btnEls[idx].click(), 0); }
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => { if (!busy) close(); });
  box.append(head, body, foot);
  overlay.append(box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && !busy) close(); });
  document.body.append(overlay);
  openCount++;
  requestAnimationFrame(() => {
    const first = body.querySelector('input:not([type=checkbox]), select, textarea') as HTMLElement | null;
    (first ?? btnEls.find((_, i) => buttons[i].primary) ?? btnEls[0])?.focus();
  });
  return {
    root: box, body, close,
    setBusy(b: boolean) { busy = b; for (const el of btnEls) el.disabled = b; box.classList.toggle('busy', b); },
  };
}

export function alertDialog(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    modal({ title, body: h('p', { class: 'msg' }, message), buttons: [{ label: 'OK', primary: true }], width: 440, onClose: () => resolve() });
  });
}

export function confirmDialog(title: string, message: string, ok = 'OK', cancel = 'Cancel'): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title, body: h('p', { class: 'msg' }, message), width: 440,
      buttons: [{ label: cancel }, { label: ok, primary: true, onClick: () => { result = true; } }],
      onClose: () => resolve(result),
    });
  });
}

/** Save / Don't Save / Cancel. */
export function saveChangesDialog(name: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    let result: 'save' | 'discard' | 'cancel' = 'cancel';
    modal({
      title: 'Save changes?', width: 460,
      body: h('p', { class: 'msg' }, `Do you want to save changes to "${name}"? Your changes will be lost if you don't save them.`),
      buttons: [
        { label: "Don't Save", danger: true, onClick: () => { result = 'discard'; } },
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: () => { result = 'save'; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, spellcheck: false }) as HTMLInputElement;
    let result: string | null = null;
    modal({
      title, width: 420,
      body: h('div', { class: 'form' }, h('label', { class: 'row' }, h('span', null, label), input)),
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => { result = input.value; } }],
      onClose: () => resolve(result),
    });
    requestAnimationFrame(() => input.select());
  });
}

/** A labeled form row. */
export function row(label: string, ...controls: (HTMLElement | string)[]): HTMLElement {
  return h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), h('div', { class: 'row-controls' }, ...controls));
}

export function progressDialog(title: string): { set(p: number, text?: string): void; close(): void; cancelled(): boolean } {
  const bar = h('div', { class: 'progress-fill' });
  const text = h('div', { class: 'progress-text' }, 'Starting…');
  let cancelled = false;
  const m = modal({
    title, width: 420,
    body: h('div', null, h('div', { class: 'progress' }, bar), text),
    buttons: [{ label: 'Cancel', onClick: () => { cancelled = true; } }],
  });
  return {
    set(p, t) { bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; if (t) text.textContent = t; },
    close() { m.close(); },
    cancelled: () => cancelled,
  };
}
