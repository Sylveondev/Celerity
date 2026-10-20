// Tiny DOM helpers (no framework: keeps the UI fast and dependency-free).

type Attrs = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range', 'color', 'submit'].includes(t.type);
  if (t instanceof HTMLSelectElement) return true;
  return false;
}

/** Numeric input that supports scrubbing by dragging its label (like Animate's hot text). */
export function numField(opts: {
  label?: string; value: number; step?: number; min?: number; max?: number; digits?: number; suffix?: string; width?: number;
  onChange: (v: number, final: boolean) => void; title?: string;
}): HTMLElement {
  const digits = opts.digits ?? 1;
  const fmt = (v: number) => {
    const s = v.toFixed(digits);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  const clampV = (v: number) => Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, v));
  const input = h('input', { class: 'num', type: 'text', value: fmt(opts.value), spellcheck: false, title: opts.title ?? '' }) as HTMLInputElement;
  if (opts.width) input.style.width = opts.width + 'px';
  let current = opts.value;
  const commit = () => {
    const raw = input.value.trim();
    // allow simple math like "100+20" or "50*2"
    const v0 = evalMath(raw);
    let v = Number.isFinite(v0) ? v0 : parseFloat(raw);
    if (!Number.isFinite(v)) { input.value = fmt(current); return; }
    v = clampV(v);
    current = v;
    input.value = fmt(v);
    opts.onChange(v, true);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { commit(); input.blur(); }
    else if (e.key === 'Escape') { input.value = fmt(current); input.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (opts.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      current = clampV(current + step);
      input.value = fmt(current);
      opts.onChange(current, true);
    }
  });
  input.addEventListener('change', commit);
  input.addEventListener('focus', () => input.select());
  const wrap = h('label', { class: 'field' });
  if (opts.label) {
    const lab = h('span', { class: 'scrub', title: 'Drag to change' }, opts.label);
    lab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = current;
      let moved = false;
      lab.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 1) moved = true;
        const v = clampV(start + Math.round(dx) * (opts.step ?? 1) * (ev.shiftKey ? 10 : 1));
        current = v;
        input.value = fmt(v);
        opts.onChange(v, false);
      };
      const up = () => {
        lab.removeEventListener('pointermove', move);
        lab.removeEventListener('pointerup', up);
        if (moved) opts.onChange(current, true);
        else input.focus();
      };
      lab.addEventListener('pointermove', move);
      lab.addEventListener('pointerup', up);
    });
    wrap.append(lab);
  }
  wrap.append(input);
  if (opts.suffix) wrap.append(h('span', { class: 'suffix' }, opts.suffix));
  return wrap;
}

/** Safe arithmetic evaluator: numbers, + - * / and parentheses. */
export function evalMath(src: string): number {
  const toks = src.match(/\d*\.?\d+(?:e[-+]?\d+)?|[-+*/()]/gi);
  if (!toks || toks.join('') !== src.replace(/\s+/g, '')) return NaN;
  let i = 0;
  const peek = () => toks[i];
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const factor = (): number => {
    const t = toks[i++];
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (t === '(') { const v = expr(); if (toks[i++] !== ')') return NaN; return v; }
    return t === undefined ? NaN : parseFloat(t);
  };
  const v = expr();
  return i === toks.length ? v : NaN;
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void, title?: string): HTMLSelectElement {
  const s = h('select', { title: title ?? '' }) as HTMLSelectElement;
  for (const [v, label] of options) s.append(h('option', { value: v, selected: v === value }, label));
  s.value = value;
  s.addEventListener('change', () => { onChange(s.value as T); s.blur(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLLabelElement {
  const c = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'check', title: title ?? '' }, c, label);
}

export function textField(value: string, onChange: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', value, placeholder, spellcheck: false }) as HTMLInputElement;
  i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
  i.addEventListener('change', () => onChange(i.value));
  return i;
}

export function button(label: string, onClick: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = h('button', { class: cls, title }, '') as HTMLButtonElement;
  b.innerHTML = label;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t!.className = ''; }, ms);
}
