// Dockable workspace: panels live in tab groups docked to the left/right of
// the window or above/below the stage, or in floating windows. Panels can be
// dragged by their tabs to any dock zone, shown/hidden, and the arrangement is
// saved as named workspaces (built-in presets plus user layouts).
import { h } from './dom';
import { icon } from './icons';

export type PanelId = 'tools' | 'timeline' | 'properties' | 'library' | 'color' | 'align' | 'transform';
export const PANEL_IDS: PanelId[] = ['tools', 'timeline', 'properties', 'library', 'color', 'align', 'transform'];

export interface PanelDef { id: PanelId; title: string; el: HTMLElement }

export interface WsGroup { panels: PanelId[]; active: PanelId; size: number }   // size: flex weight along the line
export interface WsLine { size: number; groups: WsGroup[] }                    // size: px across the line
export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export interface WsFloat { group: WsGroup; x: number; y: number; w: number; h: number }
export interface WsLayout {
  left: WsLine[];   // columns, outermost first
  right: WsLine[];  // columns, innermost first
  top: WsLine[];    // rows above the stage, outermost first
  bottom: WsLine[]; // rows below the stage, innermost first
  floats: WsFloat[];
  last?: Partial<Record<PanelId, { side: DockSide; line: number; group: number }>>;
}

const g = (panels: PanelId[], size = 1, active?: PanelId): WsGroup => ({ panels, active: active ?? panels[0], size });
const line = (size: number, ...groups: WsGroup[]): WsLine => ({ size, groups });

/** Built-in workspaces (Essentials is the default and matches the original Celerity layout). */
export const PRESETS: Record<string, () => WsLayout> = {
  Essentials: () => ({
    left: [line(44, g(['tools']))],
    right: [line(300, g(['properties', 'library'], 1.38), g(['color', 'align', 'transform'], 1))],
    top: [],
    bottom: [line(230, g(['timeline']))],
    floats: [],
  }),
  Classic: () => ({
    left: [],
    right: [line(270, g(['color', 'align', 'transform'], 1), g(['library'], 1.4)), line(260, g(['properties'])), line(44, g(['tools']))],
    top: [line(210, g(['timeline']))],
    bottom: [],
    floats: [],
  }),
  Animator: () => ({
    left: [line(44, g(['tools']))],
    right: [line(260, g(['library'], 1), g(['properties'], 1.2))],
    top: [],
    bottom: [line(320, g(['timeline'], 3), g(['transform', 'color', 'align'], 1))],
    floats: [],
  }),
  Designer: () => ({
    left: [line(44, g(['tools'])), line(250, g(['library']))],
    right: [line(300, g(['properties'], 1.3), g(['color', 'align', 'transform'], 1))],
    top: [],
    bottom: [line(190, g(['timeline']))],
    floats: [],
  }),
  'Small Screen': () => ({
    left: [line(44, g(['tools']))],
    right: [line(250, g(['properties', 'library', 'color', 'align', 'transform']))],
    top: [],
    bottom: [line(170, g(['timeline']))],
    floats: [],
  }),
};

const STORE_KEY = 'celerity.workspaces';
interface Saved { active: string; current: Record<string, WsLayout>; custom: Record<string, WsLayout> }

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Saved;
      if (s && s.current && s.custom) return s;
    }
  } catch { /* ignore */ }
  return { active: 'Essentials', current: {}, custom: {} };
}

type Target =
  | { kind: 'tab'; group: WsGroup }
  | { kind: 'split'; side: DockSide | 'float'; line: number; group: number; where: 'before' | 'after'; axis: 'line' | 'group'; floatIdx?: number }
  | { kind: 'edge'; side: DockSide; at: 'outer' | 'inner' }
  | { kind: 'float'; x: number; y: number };

export class Workspace {
  layout: WsLayout;
  name: string;
  private saved = load();
  private host: HTMLElement;
  private grid: HTMLElement;
  private centerEl: HTMLElement;
  private floatsEl: HTMLElement;
  private docks: Record<DockSide, HTMLElement>;
  private panels = new Map<PanelId, PanelDef>();
  private indicator: HTMLElement;
  onChange: (() => void) | null = null;

  constructor(host: HTMLElement, editbar: HTMLElement, stageHost: HTMLElement, panels: PanelDef[]) {
    this.host = host;
    for (const p of panels) this.panels.set(p.id, p);
    this.docks = {
      left: h('div', { class: 'ws-dock ws-left' }), right: h('div', { class: 'ws-dock ws-right' }),
      top: h('div', { class: 'ws-dock ws-top' }), bottom: h('div', { class: 'ws-dock ws-bottom' }),
    };
    this.centerEl = h('div', { class: 'ws-center' }, this.docks.top, editbar, stageHost, this.docks.bottom);
    stageHost.classList.add('ws-stage');
    this.grid = h('div', { class: 'ws' }, this.docks.left, this.centerEl, this.docks.right);
    this.floatsEl = h('div', { class: 'ws-floats' });
    this.indicator = h('div', { class: 'ws-drop' });
    host.append(this.grid, this.floatsEl, this.indicator);
    this.name = this.saved.active in PRESETS || this.saved.active in this.saved.custom ? this.saved.active : 'Essentials';
    this.layout = this.sanitize(this.saved.current[this.name] ?? this.base(this.name));
    this.render();
    window.addEventListener('resize', () => this.clampFloats());
  }

  // ---------------- workspaces ----------------
  names(): { builtIn: string[]; custom: string[] } {
    return { builtIn: Object.keys(PRESETS), custom: Object.keys(this.saved.custom) };
  }

  private base(name: string): WsLayout {
    const c = this.saved.custom[name];
    if (c) return structuredClone(c);
    return (PRESETS[name] ?? PRESETS.Essentials)();
  }

  switchTo(name: string) {
    if (!(name in PRESETS) && !(name in this.saved.custom)) return;
    this.saved.current[this.name] = structuredClone(this.layout);
    this.name = name;
    this.layout = this.sanitize(this.saved.current[name] ?? this.base(name));
    this.commit();
  }

  /** Back to the saved arrangement of the current workspace. */
  reset() {
    delete this.saved.current[this.name];
    this.layout = this.sanitize(this.base(this.name));
    this.commit();
  }

  saveAs(name: string) {
    name = name.trim();
    if (!name) return;
    this.saved.custom[name] = structuredClone(this.layout);
    this.saved.current[name] = structuredClone(this.layout);
    this.name = name;
    this.commit();
  }

  remove(name: string) {
    if (!(name in this.saved.custom)) return;
    delete this.saved.custom[name];
    delete this.saved.current[name];
    if (this.name === name) { this.name = 'Essentials'; this.layout = this.sanitize(this.saved.current.Essentials ?? this.base('Essentials')); }
    this.commit();
  }

  private persist() {
    this.saved.active = this.name;
    this.saved.current[this.name] = this.layout;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.saved)); } catch { /* storage unavailable */ }
  }

  private commit() {
    this.persist();
    this.render();
    this.onChange?.();
  }

  /** Makes sure every panel appears at most once and drops empty groups/lines. */
  private sanitize(l: WsLayout): WsLayout {
    const seen = new Set<PanelId>();
    const fixGroup = (gr: WsGroup) => {
      gr.panels = gr.panels.filter((p) => PANEL_IDS.includes(p) && !seen.has(p) && (seen.add(p), true));
      if (!gr.panels.includes(gr.active)) gr.active = gr.panels[0];
      gr.size = gr.size > 0 ? gr.size : 1;
      return gr.panels.length > 0;
    };
    for (const side of ['left', 'right', 'top', 'bottom'] as DockSide[]) {
      l[side] = (l[side] ?? []).map((ln) => ({ size: ln.size > 20 ? ln.size : 200, groups: ln.groups.filter(fixGroup) })).filter((ln) => ln.groups.length);
    }
    l.floats = (l.floats ?? []).filter((f) => fixGroup(f.group));
    l.last ??= {};
    return l;
  }

  // ---------------- panels ----------------
  private locate(id: PanelId): { side: DockSide | 'float'; line: number; group: number; gr: WsGroup } | null {
    for (const side of ['left', 'right', 'top', 'bottom'] as DockSide[]) {
      const lines = this.layout[side];
      for (let i = 0; i < lines.length; i++) for (let j = 0; j < lines[i].groups.length; j++) {
        if (lines[i].groups[j].panels.includes(id)) return { side, line: i, group: j, gr: lines[i].groups[j] };
      }
    }
    for (let i = 0; i < this.layout.floats.length; i++) if (this.layout.floats[i].group.panels.includes(id)) return { side: 'float', line: i, group: 0, gr: this.layout.floats[i].group };
    return null;
  }

  isVisible(id: PanelId) { return !!this.locate(id); }
  isActive(id: PanelId) { const l = this.locate(id); return !!l && l.gr.active === id; }

  /** Removes a panel from wherever it is (remembering where it was). */
  private detach(id: PanelId) {
    const loc = this.locate(id);
    if (!loc) return;
    if (loc.side !== 'float') this.layout.last![id] = { side: loc.side, line: loc.line, group: loc.group };
    loc.gr.panels = loc.gr.panels.filter((p) => p !== id);
    if (loc.gr.active === id) loc.gr.active = loc.gr.panels[0];
    this.layout = this.sanitize(this.layout);
  }

  hide(id: PanelId) { this.detach(id); this.commit(); }

  show(id: PanelId) {
    const loc = this.locate(id);
    if (loc) { loc.gr.active = id; this.commit(); return; }
    const last = this.layout.last?.[id];
    const lines = last ? this.layout[last.side] : null;
    const gr = lines?.[last!.line]?.groups[last!.group];
    if (gr) { gr.panels.push(id); gr.active = id; }
    else if (id === 'tools') this.layout.left.unshift(line(44, g(['tools'])));
    else if (id === 'timeline') this.layout.bottom.unshift(line(220, g(['timeline'])));
    else if (this.layout.right.length) { const l0 = this.layout.right[0]; l0.groups.push(g([id], 1)); }
    else this.layout.right.unshift(line(280, g([id])));
    this.commit();
  }

  /** Window menu behaviour: hidden -> show, shown in a background tab -> bring to front, front -> hide. */
  toggle(id: PanelId) {
    if (!this.isVisible(id)) this.show(id);
    else if (!this.isActive(id)) this.show(id);
    else this.hide(id);
  }

  // ---------------- rendering ----------------
  render() {
    // keep panel elements alive while rebuilding the containers
    for (const p of this.panels.values()) p.el.remove();
    for (const side of ['left', 'right', 'top', 'bottom'] as DockSide[]) this.renderDock(side);
    this.floatsEl.textContent = '';
    this.layout.floats.forEach((f, i) => this.floatsEl.append(this.renderFloat(f, i)));
    this.host.classList.toggle('ws-has-floats', this.layout.floats.length > 0);
    requestAnimationFrame(() => window.dispatchEvent(new Event('ws-layout')));
  }

  private renderDock(side: DockSide) {
    const dock = this.docks[side];
    dock.textContent = '';
    const lines = this.layout[side];
    const vertical = side === 'left' || side === 'right'; // lines are columns
    // line arrays are in screen order; each line's splitter sits on its stage-facing side
    lines.forEach((ln, i) => {
      const el = h('div', { class: `ws-line ${vertical ? 'ws-col' : 'ws-row'}` });
      el.style[vertical ? 'width' : 'height'] = `${ln.size}px`;
      ln.groups.forEach((gr, j) => {
        if (j > 0) el.append(this.groupSplitter(ln, j, vertical));
        el.append(this.renderGroup(gr, { side, line: i, group: j }, !vertical));
      });
      const sp = h('div', { class: `ws-split ${vertical ? 'v' : 'h'}` });
      this.dragSize(sp, vertical ? 'x' : 'y', (d) => {
        // dragging towards the stage grows docks on the left/top
        const sign = side === 'left' || side === 'top' ? 1 : -1;
        const min = this.lineMin(ln);
        ln.size = Math.max(min, Math.min(vertical ? window.innerWidth * 0.6 : window.innerHeight * 0.75, ln.size + d * sign));
        el.style[vertical ? 'width' : 'height'] = `${ln.size}px`;
      });
      if (side === 'left' || side === 'top') { dock.append(el, sp); } else { dock.append(sp, el); }
    });
  }

  private lineMin(ln: WsLine) {
    return ln.groups.every((gr) => gr.panels.length === 1 && gr.panels[0] === 'tools') ? 36 : 120;
  }

  private groupSplitter(ln: WsLine, j: number, vertical: boolean) {
    const sp = h('div', { class: `ws-split ${vertical ? 'h' : 'v'}` });
    this.dragSize(sp, vertical ? 'y' : 'x', (d) => {
      const a = ln.groups[j - 1], b = ln.groups[j];
      const els = [...(sp.parentElement?.querySelectorAll(':scope > .ws-group') ?? [])] as HTMLElement[];
      const ea = els[j - 1], eb = els[j];
      if (!ea || !eb) return;
      const pa = vertical ? ea.offsetHeight : ea.offsetWidth, pb = vertical ? eb.offsetHeight : eb.offsetWidth;
      const total = a.size + b.size, px = pa + pb;
      if (px <= 0) return;
      const na = Math.max(60, Math.min(px - 60, pa + d));
      a.size = (total * na) / px; b.size = total - a.size;
      ea.style.flex = `${a.size} 1 0`; eb.style.flex = `${b.size} 1 0`;
    });
    return sp;
  }

  private dragSize(el: HTMLElement, axis: 'x' | 'y', onDelta: (d: number) => void) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let last = axis === 'x' ? e.clientX : e.clientY;
      const mv = (ev: PointerEvent) => { const c = axis === 'x' ? ev.clientX : ev.clientY; onDelta(c - last); last = c; };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); this.persist(); window.dispatchEvent(new Event('ws-layout')); };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
  }

  private renderGroup(gr: WsGroup, at: { side: DockSide | 'float'; line: number; group: number }, horizontalLine: boolean): HTMLElement {
    const toolsOnly = gr.panels.length === 1 && gr.panels[0] === 'tools';
    const el = h('div', { class: `ws-group${toolsOnly ? ' tools-only' : ''}${horizontalLine ? ' in-row' : ''}` });
    el.style.flex = `${gr.size} 1 0`;
    (el as HTMLElement & { _ws?: unknown })._ws = { gr, at };
    const bar = h('div', { class: 'ws-tabs' });
    if (toolsOnly) {
      const grip = h('div', { class: 'ws-grip', title: 'Drag to move the Tools panel' });
      this.dragTab(grip, 'tools');
      bar.append(grip);
    } else {
      for (const id of gr.panels) {
        const def = this.panels.get(id)!;
        const t = h('button', { class: `ws-tab${gr.active === id ? ' on' : ''}`, title: `${def.title} — drag to move` }, def.title);
        t.addEventListener('click', () => { if (gr.active !== id) { gr.active = id; this.commit(); } });
        this.dragTab(t, id);
        bar.append(t);
      }
      const spacer = h('div', { class: 'ws-tabs-fill' });
      const close = h('button', { class: 'icon-btn tiny ws-close', title: `Close ${this.panels.get(gr.active)?.title ?? ''}`, html: icon('close') });
      close.addEventListener('click', () => this.hide(gr.active));
      bar.append(spacer, close);
    }
    const page = h('div', { class: 'ws-page' });
    const def = this.panels.get(gr.active);
    if (def) {
      def.el.classList.toggle('in-row', horizontalLine);
      page.append(def.el);
    }
    el.append(bar, page);
    return el;
  }

  private renderFloat(f: WsFloat, idx: number): HTMLElement {
    const el = this.renderGroup(f.group, { side: 'float', line: idx, group: 0 }, false);
    el.classList.add('ws-float');
    Object.assign(el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px`, flex: '' });
    // move by the empty part of the tab bar
    const bar = el.querySelector('.ws-tabs') as HTMLElement;
    bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.ws-tab, .ws-grip, button')) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const sx = e.clientX - f.x, sy = e.clientY - f.y;
      const mv = (ev: PointerEvent) => { f.x = ev.clientX - sx; f.y = ev.clientY - sy; this.clampFloat(f); el.style.left = `${f.x}px`; el.style.top = `${f.y}px`; };
      const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); this.persist(); };
      bar.addEventListener('pointermove', mv);
      bar.addEventListener('pointerup', up);
    });
    const grip = h('div', { class: 'ws-resize', title: 'Resize' });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, w0 = f.w, h0 = f.h;
      const mv = (ev: PointerEvent) => { f.w = Math.max(160, w0 + ev.clientX - sx); f.h = Math.max(120, h0 + ev.clientY - sy); el.style.width = `${f.w}px`; el.style.height = `${f.h}px`; };
      const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); this.persist(); window.dispatchEvent(new Event('ws-layout')); };
      grip.addEventListener('pointermove', mv);
      grip.addEventListener('pointerup', up);
    });
    el.append(grip);
    el.addEventListener('pointerdown', () => {
      // bring to front without rebuilding (a drag may be starting)
      if (el !== this.floatsEl.lastElementChild) {
        this.floatsEl.append(el);
        const i = this.layout.floats.indexOf(f);
        if (i >= 0) { this.layout.floats.splice(i, 1); this.layout.floats.push(f); }
        this.persist();
      }
    });
    return el;
  }

  private clampFloat(f: WsFloat) {
    const W = window.innerWidth, H = window.innerHeight;
    f.x = Math.max(-f.w + 80, Math.min(W - 80, f.x));
    f.y = Math.max(30, Math.min(H - 40, f.y));
  }
  private clampFloats() { for (const f of this.layout.floats) this.clampFloat(f); }

  // ---------------- drag & drop docking ----------------
  private dragTab(handle: HTMLElement, id: PanelId) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x0 = e.clientX, y0 = e.clientY;
      let started = false;
      let ghost: HTMLElement | null = null;
      let target: Target | null = null;
      handle.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
          started = true;
          ghost = h('div', { class: 'ws-ghost' }, this.panels.get(id)!.title);
          document.body.append(ghost);
          this.host.classList.add('ws-dragging');
        }
        ghost!.style.left = `${ev.clientX + 12}px`;
        ghost!.style.top = `${ev.clientY + 8}px`;
        target = this.targetAt(ev.clientX, ev.clientY, id);
        this.showIndicator(target, ev.clientX, ev.clientY);
      };
      const up = () => {
        handle.removeEventListener('pointermove', mv);
        handle.removeEventListener('pointerup', up);
        ghost?.remove();
        this.indicator.style.display = 'none';
        this.host.classList.remove('ws-dragging');
        if (started && target) this.drop(id, target);
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', up);
    });
  }

  private groupEls(): { el: HTMLElement; gr: WsGroup; at: { side: DockSide | 'float'; line: number; group: number } }[] {
    return ([...this.host.querySelectorAll('.ws-group')] as (HTMLElement & { _ws?: { gr: WsGroup; at: { side: DockSide | 'float'; line: number; group: number } } })[])
      .filter((el) => el._ws).map((el) => ({ el, gr: el._ws!.gr, at: el._ws!.at }));
  }

  private targetAt(x: number, y: number, id: PanelId): Target {
    // groups (floats first: they are on top)
    const groups = this.groupEls().sort((a, b) => (b.at.side === 'float' ? 1 : 0) - (a.at.side === 'float' ? 1 : 0));
    for (const { el, gr, at } of groups) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
      const lone = gr.panels.length === 1 && gr.panels[0] === id;
      if (at.side === 'float') return lone ? { kind: 'float', x, y } : { kind: 'tab', group: gr };
      const vertical = at.side === 'left' || at.side === 'right';
      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      if (edge > 0.25 || r.height < 60) {
        if (lone) return { kind: 'float', x, y };
        return { kind: 'tab', group: gr };
      }
      // split: along the line (new group) or across it (new line)
      const alongLine = vertical ? (fy < 0.25 || fy > 0.75) && Math.min(fy, 1 - fy) <= Math.min(fx, 1 - fx) : (fx < 0.25 || fx > 0.75) && Math.min(fx, 1 - fx) <= Math.min(fy, 1 - fy);
      if (alongLine) {
        const before = vertical ? fy < 0.5 : fx < 0.5;
        return { kind: 'split', side: at.side, line: at.line, group: at.group, where: before ? 'before' : 'after', axis: 'group' };
      }
      const before = vertical ? fx < 0.5 : fy < 0.5;
      // "before" in screen order; the line order of right/bottom docks starts at the stage side
      return { kind: 'split', side: at.side, line: at.line, group: at.group, where: before ? 'before' : 'after', axis: 'line' };
    }
    // edges of the stage area and of the window
    const st = this.centerEl.querySelector('.ws-stage')!.getBoundingClientRect();
    const win = this.grid.getBoundingClientRect();
    const near = 48;
    if (x >= st.left && x <= st.right && y >= st.top && y <= st.bottom) {
      if (x - st.left < near) return { kind: 'edge', side: 'left', at: 'inner' };
      if (st.right - x < near) return { kind: 'edge', side: 'right', at: 'inner' };
      if (y - st.top < near) return { kind: 'edge', side: 'top', at: 'inner' };
      if (st.bottom - y < near) return { kind: 'edge', side: 'bottom', at: 'inner' };
    }
    if (x - win.left < 14) return { kind: 'edge', side: 'left', at: 'outer' };
    if (win.right - x < 14) return { kind: 'edge', side: 'right', at: 'outer' };
    return { kind: 'float', x, y };
  }

  private showIndicator(t: Target | null, x: number, y: number) {
    const ind = this.indicator;
    if (!t) { ind.style.display = 'none'; return; }
    let r: { left: number; top: number; width: number; height: number } | null = null;
    const hostR = this.host.getBoundingClientRect();
    if (t.kind === 'tab') {
      const ge = this.groupEls().find((q) => q.gr === t.group);
      if (ge) r = ge.el.getBoundingClientRect();
    } else if (t.kind === 'split') {
      const ge = this.groupEls().find((q) => q.at.side === t.side && q.at.line === t.line && q.at.group === t.group);
      if (ge) {
        const b = ge.el.getBoundingClientRect();
        const vertical = t.side === 'left' || t.side === 'right';
        const alongV = (t.axis === 'group') === vertical; // split top/bottom
        r = alongV
          ? { left: b.left, top: t.where === 'before' ? b.top : b.top + b.height / 2, width: b.width, height: b.height / 2 }
          : { left: t.where === 'before' ? b.left : b.left + b.width / 2, top: b.top, width: b.width / 2, height: b.height };
      }
    } else if (t.kind === 'edge') {
      const st = this.centerEl.querySelector('.ws-stage')!.getBoundingClientRect();
      const win = this.grid.getBoundingClientRect();
      if (t.at === 'outer') r = t.side === 'left' ? { left: win.left, top: win.top, width: 120, height: win.height } : { left: win.right - 120, top: win.top, width: 120, height: win.height };
      else if (t.side === 'left') r = { left: st.left, top: st.top, width: 140, height: st.height };
      else if (t.side === 'right') r = { left: st.right - 140, top: st.top, width: 140, height: st.height };
      else if (t.side === 'top') r = { left: st.left, top: st.top, width: st.width, height: 110 };
      else r = { left: st.left, top: st.bottom - 110, width: st.width, height: 110 };
    } else {
      r = { left: x - 120, top: y - 14, width: 260, height: 220 };
    }
    if (!r) { ind.style.display = 'none'; return; }
    Object.assign(ind.style, { display: 'block', left: `${r.left - hostR.left}px`, top: `${r.top - hostR.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    ind.classList.toggle('float', t.kind === 'float');
  }

  private drop(id: PanelId, t: Target) {
    const L = this.layout;
    const sizeHint = id === 'tools' ? 44 : id === 'timeline' ? 220 : 280;
    if (t.kind === 'tab') {
      if (t.group.panels.includes(id) && t.group.panels.length === 1) return;
      this.detach(id);
      t.group.panels = t.group.panels.filter((p) => p !== id).concat(id);
      t.group.active = id;
    } else if (t.kind === 'float') {
      const loc = this.locate(id);
      if (loc?.side === 'float' && loc.gr.panels.length === 1) {
        const f = L.floats[loc.line];
        f.x = t.x - 40; f.y = t.y - 10; this.clampFloat(f);
      } else {
        this.detach(id);
        const f: WsFloat = { group: g([id]), x: t.x - 40, y: t.y - 10, w: id === 'tools' ? 64 : id === 'timeline' ? 760 : 300, h: id === 'tools' ? 560 : id === 'timeline' ? 260 : 380 };
        this.clampFloat(f);
        L.floats.push(f);
      }
    } else if (t.kind === 'edge') {
      this.detach(id);
      const ln = line(sizeHint, g([id]));
      const lines = L[t.side];
      // left/top lists start at the window edge, right/bottom lists start at the stage
      const outerFirst = t.side === 'left' || t.side === 'top';
      if ((t.at === 'outer') === outerFirst) lines.unshift(ln); else lines.push(ln);
    } else if (t.kind === 'split') {
      // resolve the target group before detaching (indices may shift)
      const side = t.side as DockSide;
      const tgtGroup = L[side][t.line]?.groups[t.group];
      const tgtLine = L[side][t.line];
      if (!tgtGroup || !tgtLine) return;
      this.detach(id);
      const lines = L[side];
      const li = lines.indexOf(tgtLine);
      if (t.axis === 'group') {
        if (li < 0) { lines.push(line(sizeHint, g([id]))); }
        else {
          const gi = tgtLine.groups.indexOf(tgtGroup);
          const share = gi >= 0 ? tgtLine.groups[gi].size / 2 : 1;
          if (gi >= 0) tgtLine.groups[gi].size = share;
          tgtLine.groups.splice(gi < 0 ? tgtLine.groups.length : t.where === 'before' ? gi : gi + 1, 0, g([id], share || 1));
        }
      } else {
        // a new line beside the target line; line arrays are in screen order (left→right, top→bottom)
        const ln = line(sizeHint, g([id]));
        const idx = li < 0 ? lines.length : li;
        lines.splice(t.where === 'before' ? idx : idx + 1, 0, ln);
      }
    }
    this.layout = this.sanitize(L);
    this.commit();
  }

  /** Brings a panel to the front of its group if it is shown (or shows it). */
  focus(id: PanelId) {
    const loc = this.locate(id);
    if (loc && loc.gr.active === id) return;
    this.show(id);
  }
}
