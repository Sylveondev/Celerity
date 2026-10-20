// Application shell: layout, menus, commands and keyboard shortcuts.
import { store, ui, setUI, onUI, loadPrefs, type ToolId } from './state';
import { Stage } from './stage';
import { tools, TOOL_LIST, editText } from './tools';
import { TimelinePanel } from './timeline-panel';
import { PropertiesPanel, documentSettingsDialog } from './props-panel';
import { LibraryPanel, newSymbolDialog, DRAG_MIME } from './library-panel';
import { ColorPanel, AlignPanel, TransformPanel } from './side-panels';
import { h, clear, isTextInput, toast, checkbox, numField } from './dom';
import { icon } from './icons';
import { dropdown, closeMenus, menusOpen, shortcutLabel, contextMenu, type MenuItem, SEP } from './menu';
import { modal, isModalOpen, row, promptDialog, confirmDialog } from './dialogs';
import { swatchButton, gradientCss } from './colorpicker';
import * as A from './actions';
import * as F from './fileops';
import * as X from './exporter';
import { platform, isElectron, isMac } from './platform';
import { timelineFrameCount } from '../core/timeline';
import { newTimeline, uniqueName, baseName } from '../core/util';
import { apply, invert } from '../core/matrix';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  alt?: string;              // secondary shortcut
  run: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const hasSel = () => store.selection.length > 0;

export class App {
  stage!: Stage;
  timeline!: TimelinePanel;
  props!: PropertiesPanel;
  library!: LibraryPanel;
  commands = new Map<string, Command>();
  private keymap = new Map<string, Command>();
  private root!: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLElement>();
  private editBar!: HTMLElement;
  private statusEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private rightTop!: HTMLElement;
  private rightBottom!: HTMLElement;

  start(host: HTMLElement) {
    loadPrefs();
    this.root = host;
    this.registerCommands();
    this.buildLayout();
    this.bindKeys();
    this.bindClipboard();
    this.bindDrop();
    this.bindPlatform();
    store.on((w) => {
      if (w.has('file') || w.has('doc')) this.updateTitle();
      if (w.has('context') || w.has('doc') || w.has('frame')) this.renderEditBar();
      if (w.has('status') || w.has('history')) this.statusEl.textContent = store.status;
    });
    onUI((k) => { if (k === 'tool') this.updateTools(); if (k === 'zoom') this.renderEditBar(); });
    this.updateTitle();
    this.renderEditBar();
    // clicking toolbar-style buttons must not steal keyboard focus (Space/Enter shortcuts)
    document.addEventListener('mousedown', (e) => {
      const b = (e.target as HTMLElement).closest?.('.icon-btn, .tool-btn, .tab, .crumb, .swatch-btn, .menubar-item');
      if (b && !b.closest('.modal')) e.preventDefault();
    });
    F.bindStage(this.stage);
    F.startAutoRecovery();
    setTimeout(() => F.checkRecovery(), 400);
    window.addEventListener('beforeunload', (e) => {
      if (!isElectron && store.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ---------------- commands ----------------
  private cmd(c: Command) { this.commands.set(c.id, c); }

  private registerCommands() {
    const c = (id: string, label: string, run: () => void, shortcut?: string, extra: Partial<Command> = {}) => this.cmd({ id, label, run, shortcut, ...extra });
    // file
    c('file.new', 'New…', () => F.newDocumentDialog(), 'Mod+N');
    c('file.open', 'Open…', () => F.openDocument(), 'Mod+O');
    c('file.save', 'Save', () => F.saveDocument(false), 'Mod+S');
    c('file.saveAs', 'Save As…', () => F.saveDocument(true), 'Mod+Shift+S');
    c('file.revert', 'Revert', async () => { if (store.filePath && await confirmDialog('Revert', 'Discard all changes and reload the last saved version?', 'Revert')) { store.dirty = false; F.openPath(store.filePath); } }, undefined, { enabled: () => !!store.filePath && store.dirty });
    c('file.close', 'Close', () => F.newDocument(), 'Mod+W');
    c('file.newWindow', 'New Window', () => platform.newWindow(), 'Mod+Shift+N');
    c('file.importStage', 'Import to Stage…', () => F.importDialog(true), 'Mod+R');
    c('file.importLibrary', 'Import to Library…', () => F.importDialog(false), 'Mod+Alt+R');
    c('file.openLibrary', 'Open External Library…', async () => { const f = await platform.openFiles(F.FLA_FILTER, false); if (f?.[0]) F.importLibraryFrom(f[0]); }, 'Mod+Shift+O');
    c('file.exportImage', 'Export Image…', () => X.exportImageDialog(), 'Mod+Alt+Shift+I');
    c('file.exportMedia', 'Export Video / Media…', () => X.exportMediaDialog('mp4'), 'Mod+Alt+Shift+S');
    c('file.exportGif', 'Export Animated GIF…', () => X.exportMediaDialog('gif'), 'Mod+Alt+Shift+G');
    c('file.exportPng', 'Export PNG Sequence…', () => X.exportMediaDialog('png-seq'));
    c('file.spriteSheet', 'Generate Sprite Sheet…', () => X.exportSpriteSheetDialog(this.library.selected.size === 1 && store.lib.get([...this.library.selected][0])?.kind === 'symbol' ? [...this.library.selected][0] : undefined), 'Mod+Alt+Shift+P');
    c('file.publishSettings', 'Publish Settings…', () => X.publishDialog(), 'Mod+Shift+F12');
    c('file.publish', 'Publish (SWF + HTML)', () => X.publishSwf(), 'Shift+F12');
    c('file.quit', isMac ? 'Quit Celerity' : 'Exit', async () => { if (await F.confirmDiscard()) { store.dirty = false; platform.setDirty(false); window.close(); } }, isMac ? undefined : 'Mod+Q');
    // edit
    c('edit.undo', 'Undo', () => store.undo(), 'Mod+Z', { enabled: () => store.canUndo() });
    c('edit.redo', 'Redo', () => store.redo(), 'Mod+Y', { alt: 'Mod+Shift+Z', enabled: () => store.canRedo() });
    c('edit.cut', 'Cut', () => { const t = A.cutSelection(); if (t) navigator.clipboard?.writeText(t).catch(() => {}); }, 'Mod+X', { enabled: hasSel });
    c('edit.copy', 'Copy', () => { const t = A.copySelection(); if (t) navigator.clipboard?.writeText(t).catch(() => {}); }, 'Mod+C', { enabled: hasSel });
    c('edit.paste', 'Paste in Center', async () => { let t: string | null = null; try { t = await navigator.clipboard.readText(); } catch { /* use internal */ } A.paste(false, t, this.stage.viewCenter()); }, 'Mod+V');
    c('edit.pasteInPlace', 'Paste in Place', async () => { let t: string | null = null; try { t = await navigator.clipboard.readText(); } catch { /* internal */ } A.paste(true, t); }, 'Mod+Shift+V');
    c('edit.clear', 'Clear', () => A.deleteSelection(), 'Delete', { alt: 'Backspace', enabled: hasSel });
    c('edit.duplicate', 'Duplicate', () => A.duplicateSelection(), 'Mod+D', { enabled: hasSel });
    c('edit.selectAll', 'Select All', () => A.selectAll(), 'Mod+A');
    c('edit.deselect', 'Deselect All', () => { store.clearSelection(); store.frameSel = null; store.emit('frame'); }, 'Mod+Shift+A');
    c('edit.cutFrames', 'Cut Frames', () => A.copyFramesCmd(true), 'Mod+Alt+X');
    c('edit.copyFrames', 'Copy Frames', () => A.copyFramesCmd(false), 'Mod+Alt+C');
    c('edit.pasteFrames', 'Paste Frames', () => A.pasteFramesCmd(false), 'Mod+Alt+V');
    c('edit.selectAllFrames', 'Select All Frames', () => A.selectAllFrames(), 'Mod+Alt+A');
    c('edit.editSymbols', 'Edit Symbols', () => this.editSymbolsMenu(), 'Mod+E');
    c('edit.editSelected', 'Edit Selected', () => { const s = store.selected()[0]; if (s) { if (s.el.type === 'symbol') store.enterSymbol(s.el.libraryItem, s.el.matrix, true); else if (s.el.type === 'group') store.enterGroup(s.el, s.layer.id); } }, undefined, { enabled: () => store.selected().some((s) => s.el.type === 'symbol' || s.el.type === 'group') });
    c('edit.editAll', 'Edit All (exit to Scene)', () => store.exitToScene(), undefined, { enabled: () => store.stack.length > 1 || store.ctx.groupPath.length > 0 });
    c('edit.preferences', 'Preferences…', () => this.preferences(), 'Mod+U');
    // view
    c('view.zoomIn', 'Zoom In', () => this.stage.zoomAt(2), 'Mod+=', { alt: 'Mod+Shift+=' });
    c('view.zoomOut', 'Zoom Out', () => this.stage.zoomAt(0.5), 'Mod+-');
    c('view.zoom100', 'Magnification 100%', () => this.stage.centerStage(1), 'Mod+1');
    c('view.fit', 'Fit in Window', () => this.stage.fitStage(), 'Mod+2');
    c('view.zoom400', 'Magnification 400%', () => this.stage.zoomAt(4 / ui.zoom), 'Mod+4');
    c('view.zoom800', 'Magnification 800%', () => this.stage.zoomAt(8 / ui.zoom), 'Mod+8');
    c('view.center', 'Center Stage', () => this.stage.centerStage(), 'Mod+0');
    c('view.grid', 'Show Grid', () => setUI('showGrid', !ui.showGrid), "Mod+'", { checked: () => ui.showGrid });
    c('view.snap', 'Snap to Objects', () => setUI('snap', !ui.snap), 'Mod+Shift+/', { checked: () => ui.snap });
    c('view.clip', 'Clip Content Outside Stage', () => setUI('clipToStage', !ui.clipToStage), undefined, { checked: () => ui.clipToStage });
    c('view.onion', 'Onion Skin', () => setUI('onion', !ui.onion), 'Alt+Shift+O', { checked: () => ui.onion });
    // insert
    c('insert.newSymbol', 'New Symbol…', () => newSymbolDialog(false), 'Mod+F8');
    c('insert.layer', 'Layer', () => store.addLayer('normal'));
    c('insert.folder', 'Layer Folder', () => store.addLayer('folder'));
    c('insert.scene', 'Scene', () => this.addScene());
    c('insert.classicTween', 'Create Classic Tween', () => A.createTween('classic'));
    c('insert.shapeTween', 'Create Shape Tween', () => A.createTween('shape'));
    c('timeline.removeTween', 'Remove Tween', () => A.createTween('none'));
    c('timeline.frame', 'Insert Frame', () => A.insertFrame(), 'F5');
    c('timeline.removeFrames', 'Remove Frames', () => A.removeFramesCmd(), 'Shift+F5');
    c('timeline.keyframe', 'Insert Keyframe', () => A.insertKeyframeCmd(false), 'F6');
    c('timeline.blankKeyframe', 'Insert Blank Keyframe', () => A.insertKeyframeCmd(true), 'F7');
    c('timeline.clearKeyframe', 'Clear Keyframe', () => A.clearKeyframeCmd(), 'Shift+F6');
    c('timeline.reverse', 'Reverse Frames', () => A.reverseFramesCmd());
    c('timeline.mask', 'Mask', () => A.convertLayerType('mask'), undefined, { checked: () => store.layer()?.type === 'mask' });
    c('timeline.guide', 'Guide', () => A.convertLayerType('guide'), undefined, { checked: () => store.layer()?.type === 'guide' });
    // modify
    c('modify.document', 'Document…', () => documentSettingsDialog(), 'Mod+J');
    c('modify.convertSymbol', 'Convert to Symbol…', () => { if (hasSel()) newSymbolDialog(true); else toast('Select something to convert.', 'error'); }, 'F8');
    c('modify.breakApart', 'Break Apart', () => A.breakApart(), 'Mod+B', { enabled: hasSel });
    c('modify.group', 'Group', () => A.groupSelection(), 'Mod+G', { enabled: hasSel });
    c('modify.ungroup', 'Ungroup', () => A.ungroup(), 'Mod+Shift+G', { enabled: hasSel });
    c('modify.distribute', 'Distribute to Layers', () => A.distributeToLayers(), 'Mod+Shift+D', { enabled: hasSel });
    c('modify.union', 'Combine Objects: Union', () => A.unionShapes(), undefined, { enabled: () => store.selected().filter((s) => s.el.type === 'shape').length > 1 });
    c('modify.rotateCW', 'Rotate 90° CW', () => A.rotate90(true), 'Mod+Shift+9', { enabled: hasSel });
    c('modify.rotateCCW', 'Rotate 90° CCW', () => A.rotate90(false), 'Mod+Shift+7', { enabled: hasSel });
    c('modify.flipH', 'Flip Horizontal', () => A.flipH(), undefined, { enabled: hasSel });
    c('modify.flipV', 'Flip Vertical', () => A.flipV(), undefined, { enabled: hasSel });
    c('modify.removeTransform', 'Remove Transform', () => A.removeTransform(), undefined, { enabled: hasSel });
    c('modify.front', 'Bring to Front', () => A.arrange('front'), 'Mod+Shift+ArrowUp', { enabled: hasSel });
    c('modify.forward', 'Bring Forward', () => A.arrange('forward'), 'Mod+ArrowUp', { enabled: hasSel });
    c('modify.backward', 'Send Backward', () => A.arrange('backward'), 'Mod+ArrowDown', { enabled: hasSel });
    c('modify.back', 'Send to Back', () => A.arrange('back'), 'Mod+Shift+ArrowDown', { enabled: hasSel });
    const al = (id: string, label: string, mode: A.AlignMode, sc?: string) => c(id, label, () => A.align(mode, this.alignToStage || store.selection.length === 1), sc, { enabled: hasSel });
    al('align.left', 'Left', 'left', 'Mod+Alt+1');
    al('align.hcenter', 'Horizontal Center', 'hcenter', 'Mod+Alt+2');
    al('align.right', 'Right', 'right', 'Mod+Alt+3');
    al('align.top', 'Top', 'top', 'Mod+Alt+4');
    al('align.vcenter', 'Vertical Center', 'vcenter', 'Mod+Alt+5');
    al('align.bottom', 'Bottom', 'bottom', 'Mod+Alt+6');
    al('align.distH', 'Distribute Horizontal Centers', 'distH', 'Mod+Alt+7');
    al('align.distV', 'Distribute Vertical Centers', 'distV', 'Mod+Alt+9');
    al('align.matchW', 'Make Same Width', 'matchW', 'Mod+Alt+Shift+7');
    al('align.matchH', 'Make Same Height', 'matchH', 'Mod+Alt+Shift+9');
    c('align.toStage', 'Align to Stage', () => { this.alignToStage = !this.alignToStage; }, 'Mod+Alt+8', { checked: () => this.alignToStage });
    // control
    c('control.play', 'Play', () => this.stage.togglePlay(), 'Enter');
    c('control.rewind', 'Rewind', () => store.setFrame(0), 'Shift+,');
    c('control.end', 'Go to End', () => store.setFrame(timelineFrameCount(store.timeline()) - 1), 'Shift+.');
    c('control.next', 'Step Forward One Frame', () => { this.stage.stop(); store.setFrame(store.frame + 1); }, '.');
    c('control.prev', 'Step Backward One Frame', () => { this.stage.stop(); store.setFrame(store.frame - 1); }, ',');
    c('control.test', 'Test Movie', () => X.testMovie(), 'Mod+Enter');
    c('control.loop', 'Loop Playback', () => setUI('loop', !ui.loop), undefined, { checked: () => ui.loop });
    // window
    c('window.timeline', 'Timeline', () => this.togglePanel('timeline'), 'Mod+Alt+T', { checked: () => !this.root.classList.contains('no-timeline') });
    c('window.properties', 'Properties', () => this.showTab('properties'), 'Mod+F3');
    c('window.library', 'Library', () => this.showTab('library'), 'Mod+L');
    c('window.color', 'Color', () => this.showTab('color'), 'Mod+Shift+F9');
    c('window.align', 'Align', () => this.showTab('align'), 'Mod+K');
    c('window.transform', 'Transform', () => this.showTab('transform'), 'Mod+T');
    c('window.tools', 'Tools', () => this.togglePanel('tools'), 'Mod+F2', { checked: () => !this.root.classList.contains('no-tools') });
    c('window.fullscreen', 'Toggle Full Screen', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }, 'F11');
    // help
    c('help.shortcuts', 'Keyboard Shortcuts', () => this.shortcutsDialog(), 'F1');
    c('help.about', 'About Celerity', () => this.about());
    // tools
    for (const t of TOOL_LIST) if (t.key) c(`tool.${t.id}`, t.name, () => this.setTool(t.id), t.key);
    c('tool.polystarAlt', 'PolyStar Tool', () => this.setTool('polystar'), 'Shift+R');
    c('tool.swapColors', 'Swap Colors', () => this.swapColors(), 'X');
    c('tool.defaultColors', 'Default Colors', () => this.defaultColors(), 'D');
    c('scene.prev', 'Previous Scene', () => store.setScene(store.sceneIndex - 1), 'PageUp', { enabled: () => store.sceneIndex > 0 });
    c('scene.next', 'Next Scene', () => store.setScene(store.sceneIndex + 1), 'PageDown', { enabled: () => store.sceneIndex < store.doc.scenes.length - 1 });

    for (const cmd of this.commands.values()) {
      if (cmd.shortcut) this.keymap.set(cmd.shortcut, cmd);
      if (cmd.alt) this.keymap.set(cmd.alt, cmd);
    }
  }

  alignToStage = false;

  run(id: string) {
    const c = this.commands.get(id);
    if (!c) return;
    // never run commands in the middle of a drag (keeps undo history consistent)
    if (store.isLive) return;
    if (c.enabled && !c.enabled()) return;
    try { c.run(); } catch (e) { console.error(e); toast((e as Error).message, 'error'); }
  }

  private item(id: string, label?: string): MenuItem {
    const c = this.commands.get(id)!;
    return { label: label ?? c.label, shortcut: c.shortcut, action: () => this.run(id), enabled: c.enabled, checked: c.checked };
  }

  private menus(): [string, () => MenuItem[]][] {
    const i = (id: string, label?: string) => this.item(id, label);
    return [
      ['File', () => [
        i('file.new'), i('file.newWindow'), i('file.open'),
        { label: 'Open Recent', submenu: [] },
        i('file.close'), SEP, i('file.save'), i('file.saveAs'), i('file.revert'), SEP,
        { label: 'Import', submenu: [i('file.importStage'), i('file.importLibrary'), i('file.openLibrary')] },
        { label: 'Export', submenu: [i('file.exportImage'), i('file.exportMedia'), i('file.exportGif'), i('file.exportPng'), SEP, i('file.spriteSheet')] },
        SEP, i('file.publishSettings'), i('file.publish'), ...(isElectron && !isMac ? [SEP, i('file.quit')] : []),
      ]],
      ['Edit', () => [
        i('edit.undo', store.canUndo() ? `Undo` : 'Undo'), i('edit.redo'), SEP,
        i('edit.cut'), i('edit.copy'), i('edit.paste'), i('edit.pasteInPlace'), i('edit.clear'), i('edit.duplicate'), SEP,
        i('edit.selectAll'), i('edit.deselect'), SEP,
        { label: 'Timeline', submenu: [i('timeline.removeFrames'), i('edit.cutFrames'), i('edit.copyFrames'), i('edit.pasteFrames'), i('edit.selectAllFrames'), i('timeline.reverse')] },
        SEP, i('edit.editSymbols'), i('edit.editSelected'), i('edit.editAll'), SEP, i('edit.preferences'),
      ]],
      ['View', () => [
        i('view.zoomIn'), i('view.zoomOut'),
        { label: 'Magnification', submenu: [i('view.zoom100'), i('view.fit'), i('view.zoom400'), i('view.zoom800'), i('view.center')] },
        SEP, i('view.grid'), i('view.snap'), i('view.clip'), i('view.onion'),
      ]],
      ['Insert', () => [
        i('insert.newSymbol'), SEP,
        { label: 'Timeline', submenu: [i('insert.layer'), i('insert.folder'), SEP, i('timeline.frame'), i('timeline.keyframe'), i('timeline.blankKeyframe')] },
        i('insert.classicTween'), i('insert.shapeTween'), i('timeline.removeTween'), SEP, i('insert.scene'),
      ]],
      ['Modify', () => [
        i('modify.document'), SEP, i('modify.convertSymbol'), i('modify.breakApart'), SEP,
        { label: 'Timeline', submenu: [i('modify.distribute'), SEP, i('timeline.frame'), i('timeline.removeFrames'), i('timeline.keyframe'), i('timeline.blankKeyframe'), i('timeline.clearKeyframe'), i('timeline.reverse'), SEP, i('timeline.mask'), i('timeline.guide')] },
        { label: 'Transform', submenu: [{ label: 'Free Transform', shortcut: 'Q', action: () => this.setTool('transform') }, SEP, i('modify.rotateCW'), i('modify.rotateCCW'), SEP, i('modify.flipH'), i('modify.flipV'), SEP, i('modify.removeTransform')] },
        { label: 'Arrange', submenu: [i('modify.front'), i('modify.forward'), i('modify.backward'), i('modify.back')] },
        { label: 'Align', submenu: [i('align.left'), i('align.hcenter'), i('align.right'), SEP, i('align.top'), i('align.vcenter'), i('align.bottom'), SEP, i('align.distH'), i('align.distV'), i('align.matchW'), i('align.matchH'), SEP, i('align.toStage')] },
        { label: 'Combine Objects', submenu: [i('modify.union')] },
        SEP, i('modify.group'), i('modify.ungroup'),
      ]],
      ['Control', () => [
        i('control.play'), i('control.rewind'), i('control.end'), i('control.next'), i('control.prev'), SEP, i('control.test'), SEP, i('control.loop'),
        ...(store.doc.scenes.length > 1 ? [SEP, i('scene.prev'), i('scene.next')] : []),
      ]],
      ['Window', () => [
        i('window.timeline'), i('window.tools'), SEP, i('window.properties'), i('window.library'), i('window.color'), i('window.align'), i('window.transform'), SEP,
        { label: 'Reset Workspace', action: () => this.resetWorkspace() }, i('window.fullscreen'),
      ]],
      ['Help', () => [i('help.shortcuts'), SEP, i('help.about')]],
    ];
  }

  // ---------------- layout ----------------
  private buildLayout() {
    const menubar = h('div', { class: 'menubar' }, h('span', { class: 'app-logo', title: 'Celerity' }, 'Ce'));
    for (const [name, items] of this.menus()) {
      const m = h('div', { class: 'menubar-item', tabindex: '-1' }, name);
      const open = async () => {
        let list = items();
        const rec = list.find((x) => x.label === 'Open Recent');
        if (rec) {
          const paths = await platform.recent();
          rec.submenu = paths.length ? paths.map((p) => ({ label: p, action: () => F.openPath(p) })) : [{ label: '(none)', enabled: false }];
          if (!isElectron) rec.enabled = false;
        }
        list = list.filter(Boolean);
        menubar.querySelectorAll('.menubar-item').forEach((x) => x.classList.remove('open'));
        m.classList.add('open');
        dropdown(list, m, () => m.classList.remove('open'));
      };
      m.addEventListener('pointerdown', (e) => { e.preventDefault(); if (m.classList.contains('open') && menusOpen()) { closeMenus(); return; } open(); });
      m.addEventListener('pointerenter', () => { if (menusOpen() && !m.classList.contains('open') && menubar.querySelector('.menubar-item.open')) open(); });
      menubar.append(m);
    }
    this.statusEl = h('span', { class: 'menubar-status' });
    this.titleEl = h('span', { class: 'doc-title' });
    menubar.append(h('span', { class: 'menubar-spacer' }), this.titleEl, h('span', { class: 'menubar-spacer' }), this.statusEl);

    // tools
    const toolbar = h('div', { class: 'toolbar' });
    const groups: ToolId[][] = [['select', 'subselect', 'transform', 'gradient'], ['pen', 'text', 'line', 'rect', 'oval', 'polystar', 'pencil', 'brush'], ['bucket', 'ink', 'eyedropper', 'eraser'], ['hand', 'zoom']];
    for (const g of groups) {
      for (const id of g) {
        const t = TOOL_LIST.find((x) => x.id === id)!;
        const b = h('button', { class: 'tool-btn', title: `${t.name}${t.key ? ` (${t.key})` : ''}`, html: icon(t.icon), 'data-tool': id });
        b.addEventListener('click', () => this.setTool(id));
        this.toolButtons.set(id, b);
        toolbar.append(b);
      }
      toolbar.append(h('div', { class: 'tool-sep' }));
    }
    const strokeSw = swatchButton(() => ({ color: ui.strokeColor, alpha: ui.strokeAlpha, none: ui.strokeNone }), (v) => { setUI('strokeColor', v.color); setUI('strokeAlpha', v.alpha); setUI('strokeNone', v.none); }, 'Stroke color', 'stroke');
    const fillSw = swatchButton(() => ({ color: ui.fillColor, alpha: ui.fillAlpha, none: ui.fillNone, css: ui.fillKind !== 'solid' ? gradientCss(ui.fillStops) : undefined }), (v) => { setUI('fillKind', 'solid'); setUI('fillColor', v.color); setUI('fillAlpha', v.alpha); setUI('fillNone', v.none); }, 'Fill color', 'fill');
    onUI((k) => { if (k.startsWith('fill') || k.startsWith('stroke')) { (strokeSw as unknown as { repaint(): void }).repaint(); (fillSw as unknown as { repaint(): void }).repaint(); } });
    const mini = (ic: string, title: string, fn: () => void) => { const b = h('button', { class: 'icon-btn tiny', title, html: icon(ic) }); b.addEventListener('click', fn); return b; };
    const snapBtn = h('button', { class: `icon-btn tiny toggle ${ui.snap ? 'on' : ''}`, title: 'Snap to objects', html: icon('snap') });
    snapBtn.addEventListener('click', () => setUI('snap', !ui.snap));
    onUI((k) => { if (k === 'snap') snapBtn.classList.toggle('on', ui.snap); });
    toolbar.append(h('div', { class: 'tool-colors' }, h('div', { class: 'sw-stack' }, strokeSw, fillSw),
      h('div', { class: 'sw-mini' }, mini('reset', 'Black and white (D)', () => this.defaultColors()), mini('swap', 'Swap colors (X)', () => this.swapColors()), mini('noColor', 'No color', () => setUI('fillNone', !ui.fillNone)))),
    h('div', { class: 'tool-sep' }), snapBtn);

    // center column
    this.editBar = h('div', { class: 'editbar' });
    const stageHost = h('div', { class: 'stage-host' });
    const tlHost = h('div', { class: 'timeline-host' });
    const vsplit = h('div', { class: 'splitter h', title: 'Drag to resize' });
    const center = h('div', { class: 'center' }, this.editBar, stageHost, vsplit, tlHost);

    // right dock
    this.rightTop = h('div', { class: 'dock-group' });
    this.rightBottom = h('div', { class: 'dock-group' });
    const dsplit = h('div', { class: 'splitter h', title: 'Drag to resize' });
    const right = h('div', { class: 'right-dock' }, this.rightTop, dsplit, this.rightBottom);
    const rsplit = h('div', { class: 'splitter v', title: 'Drag to resize' });

    const main = h('div', { class: 'main' }, toolbar, center, rsplit, right);
    this.root.append(menubar, main);

    this.stage = new Stage(stageHost);
    this.timeline = new TimelinePanel(tlHost, this.stage);
    this.stage.canvas.addEventListener('contextmenu', (e) => this.stageContextMenu(e));

    const propsHost = h('div', { class: 'tab-page' });
    const libHost = h('div', { class: 'tab-page' });
    this.props = new PropertiesPanel(propsHost);
    this.library = new LibraryPanel(libHost);
    this.makeTabs(this.rightTop, [['properties', 'Properties', propsHost], ['library', 'Library', libHost]]);
    const colorHost = h('div', { class: 'tab-page' });
    const alignHost = h('div', { class: 'tab-page' });
    const transformHost = h('div', { class: 'tab-page' });
    new ColorPanel(colorHost);
    new AlignPanel(alignHost);
    new TransformPanel(transformHost);
    this.makeTabs(this.rightBottom, [['color', 'Color', colorHost], ['align', 'Align', alignHost], ['transform', 'Transform', transformHost]]);

    // splitters (sizes persisted)
    const sizes = this.loadSizes();
    const apply = () => {
      this.root.style.setProperty('--tl-h', `${sizes.tl}px`);
      this.root.style.setProperty('--right-w', `${sizes.right}px`);
      this.root.style.setProperty('--dock-split', `${sizes.dock}px`);
    };
    apply();
    this.splitter(vsplit, 'y', (d) => { sizes.tl = Math.max(90, Math.min(window.innerHeight - 200, sizes.tl - d)); apply(); }, () => this.saveSizes(sizes));
    this.splitter(rsplit, 'x', (d) => { sizes.right = Math.max(220, Math.min(560, sizes.right - d)); apply(); }, () => this.saveSizes(sizes));
    this.splitter(dsplit, 'y', (d) => { sizes.dock = Math.max(150, Math.min(window.innerHeight - 160, sizes.dock + d)); apply(); }, () => this.saveSizes(sizes));
    this.updateTools();
  }

  private loadSizes() {
    const def = { tl: 230, right: 300, dock: Math.round(window.innerHeight * 0.58) };
    try { return { ...def, ...JSON.parse(localStorage.getItem('celerity.layout') || '{}') }; } catch { return def; }
  }
  private saveSizes(s: unknown) { try { localStorage.setItem('celerity.layout', JSON.stringify(s)); } catch { /* ignore */ } }
  private resetWorkspace() {
    try { localStorage.removeItem('celerity.layout'); } catch { /* ignore */ }
    this.root.classList.remove('no-timeline', 'no-tools');
    const s = this.loadSizes();
    this.root.style.setProperty('--tl-h', `${s.tl}px`);
    this.root.style.setProperty('--right-w', `${s.right}px`);
    this.root.style.setProperty('--dock-split', `${s.dock}px`);
  }

  private splitter(el: HTMLElement, axis: 'x' | 'y', onDelta: (d: number) => void, done: () => void) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let last = axis === 'x' ? e.clientX : e.clientY;
      const mv = (ev: PointerEvent) => { const cur = axis === 'x' ? ev.clientX : ev.clientY; onDelta(cur - last); last = cur; };
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); done(); };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
  }

  private tabSwitchers = new Map<string, () => void>();
  private makeTabs(host: HTMLElement, tabs: [string, string, HTMLElement][]) {
    const bar = h('div', { class: 'tabbar' });
    const pages = h('div', { class: 'tab-pages' });
    const show = (id: string) => {
      bar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', (t as HTMLElement).dataset.id === id));
      for (const [tid, , page] of tabs) page.classList.toggle('on', tid === id);
    };
    for (const [id, label, page] of tabs) {
      const t = h('button', { class: 'tab', 'data-id': id }, label);
      t.addEventListener('click', () => show(id));
      bar.append(t);
      pages.append(page);
      this.tabSwitchers.set(id, () => show(id));
    }
    host.append(bar, pages);
    show(tabs[0][0]);
  }

  showTab(id: string) { this.tabSwitchers.get(id)?.(); }
  private togglePanel(which: 'timeline' | 'tools') {
    this.root.classList.toggle(`no-${which}`);
    this.stage.resize();
  }

  // ---------------- edit bar ----------------
  private renderEditBar() {
    const eb = this.editBar;
    if (!eb) return;
    clear(eb);
    const crumbs = h('div', { class: 'crumbs' });
    if (store.stack.length > 1 || store.ctx.groupPath.length) {
      const back = h('button', { class: 'icon-btn', title: 'Back (exit editing)', html: icon('back') });
      back.addEventListener('click', () => store.exitContext());
      crumbs.append(back);
    }
    const scene = h('button', { class: 'crumb', title: 'Edit scene' }, h('span', { html: icon('scene') }), store.scene().name);
    scene.addEventListener('click', () => store.exitToScene());
    crumbs.append(scene);
    store.stack.slice(1).forEach((e, i) => {
      crumbs.append(h('span', { class: 'crumb-sep' }, '›'));
      const it = store.lib.get(e.symbol!);
      const b = h('button', { class: 'crumb' }, h('span', { html: icon(it?.kind === 'symbol' ? it.symbolType : 'graphic') }), baseName(e.symbol ?? ''));
      b.addEventListener('click', () => { while (store.stack.length > i + 2) store.stack.pop(); store.exitGroups(); store.selection = []; store.emit('context', 'frame', 'selection', 'doc'); });
      crumbs.append(b);
    });
    if (store.ctx.groupPath.length) {
      crumbs.append(h('span', { class: 'crumb-sep' }, '›'), h('span', { class: 'crumb' }, h('span', { html: icon('objectDraw') }), 'Group'));
    }
    const scenesBtn = h('button', { class: 'icon-btn', title: 'Edit scene', html: icon('scene') });
    scenesBtn.addEventListener('click', () => dropdown([
      ...store.doc.scenes.map((s, i) => ({ label: s.name, checked: i === store.sceneIndex, action: () => store.setScene(i) })),
      SEP,
      { label: 'Add Scene', action: () => this.addScene() },
      { label: 'Rename Scene…', action: () => this.renameScene() },
      { label: 'Delete Scene', enabled: store.doc.scenes.length > 1, action: () => this.deleteScene() },
    ], scenesBtn));
    const symBtn = h('button', { class: 'icon-btn', title: 'Edit symbol (Ctrl+E)', html: icon('graphic') });
    symBtn.addEventListener('click', () => this.editSymbolsMenu(symBtn));
    const zoomSel = h('select', { class: 'zoom-select', title: 'Zoom' }) as HTMLSelectElement;
    const pct = Math.round(ui.zoom * 100);
    const levels = [25, 50, 100, 200, 400, 800];
    zoomSel.append(h('option', { value: 'fit' }, 'Fit in Window'), h('option', { value: 'center' }, 'Center Stage'), ...levels.map((l) => h('option', { value: String(l) }, `${l}%`)));
    if (!levels.includes(pct)) zoomSel.prepend(h('option', { value: String(pct) }, `${pct}%`));
    zoomSel.value = String(pct);
    zoomSel.addEventListener('change', () => {
      const v = zoomSel.value;
      if (v === 'fit') this.stage.fitStage();
      else if (v === 'center') this.stage.centerStage();
      else this.stage.centerStage(Number(v) / 100);
    });
    zoomSel.addEventListener('keydown', (e) => e.stopPropagation());
    const clipBtn = h('button', { class: `icon-btn toggle ${ui.clipToStage ? 'on' : ''}`, title: 'Clip content outside the stage', html: icon('outline') });
    clipBtn.addEventListener('click', () => { setUI('clipToStage', !ui.clipToStage); this.renderEditBar(); });
    const centerBtn = h('button', { class: 'icon-btn', title: 'Center stage', html: icon('center') });
    centerBtn.addEventListener('click', () => this.stage.centerStage());
    eb.append(crumbs, h('span', { class: 'eb-spacer' }), scenesBtn, symBtn, clipBtn, centerBtn, zoomSel);
  }

  private editSymbolsMenu(anchor?: HTMLElement) {
    const syms = store.doc.library.filter((i) => i.kind === 'symbol');
    const items: MenuItem[] = syms.length ? syms.map((s) => ({ label: s.name, action: () => store.enterSymbol(s.name, null, false) })) : [{ label: 'No symbols', enabled: false }];
    if (anchor) dropdown(items, anchor);
    else contextMenu(items, window.innerWidth / 2 - 100, 80);
  }

  private addScene() {
    const name = uniqueName(new Set(store.doc.scenes.map((s) => s.name)), `Scene ${store.doc.scenes.length + 1}`);
    store.transact('Add Scene', () => { store.doc.scenes.push(newTimeline(name)); });
    store.setScene(store.doc.scenes.length - 1);
  }
  private async renameScene() {
    const v = await promptDialog('Rename Scene', 'Name', store.scene().name);
    if (v && v.trim()) store.transact('Rename Scene', () => { store.scene().name = v.trim(); });
  }
  private async deleteScene() {
    if (store.doc.scenes.length < 2) return;
    if (!(await confirmDialog('Delete Scene', `Delete "${store.scene().name}"?`, 'Delete'))) return;
    const i = store.sceneIndex;
    store.transact('Delete Scene', () => { store.doc.scenes.splice(i, 1); });
    store.setScene(Math.max(0, i - 1));
  }

  // ---------------- tools ----------------
  setTool(id: ToolId) {
    if (ui.tool === id) return;
    const prev = tools[ui.tool];
    prev.deactivate?.(this.stage);
    setUI('tool', id);
  }
  private updateTools() {
    for (const [id, b] of this.toolButtons) b.classList.toggle('on', id === ui.tool);
    this.stage?.updateCursor();
  }
  private swapColors() {
    const f = { c: ui.fillColor, a: ui.fillAlpha, n: ui.fillNone };
    setUI('fillColor', ui.strokeColor); setUI('fillAlpha', ui.strokeAlpha); setUI('fillNone', ui.strokeNone);
    setUI('strokeColor', f.c); setUI('strokeAlpha', f.a); setUI('strokeNone', f.n);
  }
  private defaultColors() {
    setUI('strokeColor', '#000000'); setUI('strokeAlpha', 1); setUI('strokeNone', false);
    setUI('fillColor', '#FFFFFF'); setUI('fillAlpha', 1); setUI('fillNone', false);
  }

  // ---------------- stage context menu ----------------
  private stageContextMenu(e: MouseEvent) {
    e.preventDefault();
    const r = this.stage.canvas.getBoundingClientRect();
    const p = this.stage.screenToEdit(e.clientX - r.left, e.clientY - r.top);
    const hit = this.stage.hitTest(p.x, p.y);
    if (hit && !store.selection.includes(hit.el.id)) store.select([hit.el.id]);
    const i = (id: string, label?: string) => this.item(id, label);
    const items: MenuItem[] = hit ? [
      i('edit.cut'), i('edit.copy'), i('edit.paste'), i('edit.pasteInPlace'), i('edit.duplicate'), i('edit.clear'), SEP,
      i('modify.convertSymbol'), i('modify.breakApart'), i('modify.group'), i('modify.ungroup'), SEP,
      { label: 'Arrange', submenu: [i('modify.front'), i('modify.forward'), i('modify.backward'), i('modify.back')] },
      { label: 'Transform', submenu: [i('modify.rotateCW'), i('modify.rotateCCW'), i('modify.flipH'), i('modify.flipV'), i('modify.removeTransform')] },
      SEP, i('insert.classicTween'), i('insert.shapeTween'),
      ...(hit.el.type === 'symbol' ? [SEP, i('edit.editSelected', 'Edit in Place'), { label: 'Edit Symbol', action: () => store.enterSymbol((hit.el as { libraryItem: string }).libraryItem, null, false) }] : []),
      ...(hit.el.type === 'text' ? [SEP, { label: 'Edit Text', action: () => editText(this.stage, hit.el as never) }] : []),
    ] : [
      i('edit.paste'), i('edit.pasteInPlace'), i('edit.selectAll'), SEP,
      i('view.grid'), i('view.snap'), i('view.onion'), SEP, i('modify.document'),
    ];
    contextMenu(items, e.clientX, e.clientY);
  }

  // ---------------- keyboard ----------------
  static keyString(e: KeyboardEvent): string {
    const parts: string[] = [];
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod) parts.push('Mod');
    if (isMac && e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let k = e.key;
    const code = e.code;
    if (code.startsWith('Key')) k = code.slice(3);
    else if (code.startsWith('Digit')) k = code.slice(5);
    else if (code.startsWith('Numpad') && /\d$/.test(code)) k = code.slice(6);
    else {
      const map: Record<string, string> = { Comma: ',', Period: '.', Equal: '=', Minus: '-', Slash: '/', Quote: "'", Semicolon: ';', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter' };
      if (map[code]) k = map[code];
      else if (k === ' ') k = 'Space';
      else if (k.length === 1) k = k.toUpperCase();
    }
    parts.push(k);
    return parts.join('+');
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (isModalOpen() || menusOpen()) return;
      if (e.isComposing) return;
      const target = e.target as HTMLElement;
      const inText = isTextInput(target);
      const ks = App.keyString(e);
      if (inText) {
        // allow global save/undo shortcuts even from fields? Only save/test.
        if (ks === 'Mod+S' || ks === 'Mod+Enter') { e.preventDefault(); (target as HTMLInputElement).blur?.(); this.run(ks === 'Mod+S' ? 'file.save' : 'control.test'); }
        return;
      }
      if (this.stage.toolKey(e)) { e.preventDefault(); return; }
      // clipboard keys go through DOM clipboard events
      if (['Mod+C', 'Mod+X', 'Mod+V'].includes(ks)) return;
      if (ks === 'Escape') {
        e.preventDefault();
        if (store.isLive) { store.cancelLive(); return; }
        if (store.selection.length) store.clearSelection();
        else if (store.frameSel) { store.frameSel = null; store.emit('frame'); }
        else store.exitContext();
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const base = ks.replace(/^Shift\+/, '');
      if (arrows[base] && (ks === base || ks === 'Shift+' + base)) {
        if (store.selection.length) {
          e.preventDefault();
          const k = e.shiftKey ? 10 : 1;
          A.nudge(arrows[base][0] * k, arrows[base][1] * k);
        }
        return;
      }
      const cmd = this.keymap.get(ks);
      if (cmd) {
        e.preventDefault();
        if (e.repeat && !['control.next', 'control.prev', 'view.zoomIn', 'view.zoomOut', 'timeline.frame'].includes(cmd.id)) return;
        this.run(cmd.id);
      }
    });
  }

  private bindClipboard() {
    const active = () => !isModalOpen() && !isTextInput(document.activeElement) && !menusOpen();
    document.addEventListener('copy', (e) => {
      if (!active()) return;
      const t = A.copySelection();
      if (t) { e.clipboardData?.setData('text/plain', t); e.preventDefault(); }
    });
    document.addEventListener('cut', (e) => {
      if (!active()) return;
      const t = A.cutSelection();
      if (t) { e.clipboardData?.setData('text/plain', t); e.preventDefault(); }
    });
    document.addEventListener('paste', (e) => {
      if (!active()) return;
      e.preventDefault();
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        Promise.all(files.map(async (f) => ({ name: f.name || 'Pasted image.png', path: null, data: new Uint8Array(await f.arrayBuffer()) }))).then((list) => F.importFiles(list, true));
        return;
      }
      const t = e.clipboardData?.getData('text/plain') ?? null;
      A.paste(false, t, this.stage.viewCenter());
    });
  }

  private bindDrop() {
    const el = this.stage.el;
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    el.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      const r = this.stage.canvas.getBoundingClientRect();
      const p = apply(invert(this.stage.editToScreen()), e.clientX - r.left, e.clientY - r.top);
      const item = e.dataTransfer.getData(DRAG_MIME);
      if (item) { A.placeLibraryItem(item, p.x, p.y); return; }
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      const list = await Promise.all(files.map(async (f) => ({ name: f.name, path: (f as File & { path?: string }).path ?? null, data: new Uint8Array(await f.arrayBuffer()) })));
      const fla = list.find((f) => /\.fla$/i.test(f.name));
      if (fla && list.length === 1) { if (await F.confirmDiscard()) F.openFile(fla); return; }
      F.importFiles(list.filter((f) => !/\.fla$/i.test(f.name)), true, p);
    });
    // prevent the window from navigating to dropped files elsewhere
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  private bindPlatform() {
    platform.on('app:open-path', (p) => F.openPath(String(p)));
    platform.on('app:command', (id) => {
      const key = String(id);
      const fn = this.nativeActions.get(key);
      if (fn) { fn(); return; }
      const m: Record<string, string> = { 'app.preferences': 'edit.preferences' };
      this.run(m[key] ?? key);
    });
    if (isElectron && isMac) {
      document.body.classList.add('mac-native');
      let t = 0;
      const sync = () => { clearTimeout(t); t = window.setTimeout(() => this.syncNativeMenu(), 120); };
      store.on(sync);
      onUI(sync);
      window.addEventListener('focus', sync);
      sync();
    }
    platform.on('app:save-and-close', async () => {
      if (await F.saveDocument(false)) { platform.setDirty(false); platform.closeNow(); }
    });
  }

  // ---------------- macOS native menu ----------------
  private nativeActions = new Map<string, () => void>();
  private async syncNativeMenu() {
    this.nativeActions.clear();
    let n = 0;
    const recent = await platform.recent();
    const accel = (s?: string) => s ? s.replace(/Mod\+/g, 'CmdOrCtrl+').replace(/ArrowUp/g, 'Up').replace(/ArrowDown/g, 'Down').replace(/ArrowLeft/g, 'Left').replace(/ArrowRight/g, 'Right').replace(/^Enter$|\+Enter$/g, (m) => m.replace('Enter', 'Return')) : undefined;
    const roles: Record<string, string> = { 'edit.cut': 'cut', 'edit.copy': 'copy', 'edit.paste': 'paste' };
    const conv = (items: MenuItem[]): unknown[] => items.map((it) => {
      if (it.separator) return { separator: true };
      if (it.label === 'Open Recent') {
        return { label: 'Open Recent', submenu: recent.length ? recent.map((p) => { const id = `n${n++}`; this.nativeActions.set(id, () => F.openPath(p)); return { id, label: p }; }) : [{ label: '(none)', enabled: false, id: 'none' }] };
      }
      const cmdId = [...this.commands.values()].find((c) => c.label === it.label && c.shortcut === it.shortcut)?.id;
      if (cmdId && roles[cmdId]) return { role: roles[cmdId] };
      if (it.submenu) return { label: it.label, submenu: conv(typeof it.submenu === 'function' ? it.submenu() : it.submenu) };
      const id = `n${n++}`;
      if (it.action) this.nativeActions.set(id, it.action);
      const en = typeof it.enabled === 'function' ? it.enabled() : it.enabled;
      const ch = typeof it.checked === 'function' ? it.checked() : it.checked;
      return { id, label: it.label, accelerator: accel(it.shortcut), enabled: en !== false, checked: it.checked === undefined ? undefined : !!ch };
    });
    const model = this.menus().map(([name, items]) => ({ label: name, submenu: conv(items()) }));
    platform.setMenu(model);
  }

  private updateTitle() {
    const t = `${store.fileName}${store.dirty ? ' •' : ''} — Celerity`;
    platform.setTitle(t);
    if (this.titleEl) this.titleEl.textContent = `${store.fileName}${store.dirty ? ' •' : ''}`;
    platform.setDirty(store.dirty);
  }

  // ---------------- dialogs ----------------
  private shortcutsDialog() {
    const groups = new Map<string, Command[]>();
    for (const c of this.commands.values()) {
      if (!c.shortcut) continue;
      const g = c.id.split('.')[0];
      const name = { file: 'File', edit: 'Edit', view: 'View', insert: 'Insert', timeline: 'Timeline', modify: 'Modify', align: 'Align', control: 'Control', window: 'Window', help: 'Help', tool: 'Tools', scene: 'Scenes' }[g] ?? g;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(c);
    }
    const body = h('div', { class: 'shortcuts' });
    for (const [g, list] of groups) {
      body.append(h('h4', null, g));
      const tbl = h('div', { class: 'sc-grid' });
      for (const c of list) tbl.append(h('span', null, c.label), h('kbd', null, shortcutLabel(c.shortcut!) + (c.alt ? `  /  ${shortcutLabel(c.alt)}` : '')));
      body.append(tbl);
    }
    body.append(h('h4', null, 'Stage'), h('div', { class: 'sc-grid' },
      h('span', null, 'Pan'), h('kbd', null, 'Space + drag / middle mouse / scroll'),
      h('span', null, 'Zoom'), h('kbd', null, shortcutLabel('Mod+') + 'scroll'),
      h('span', null, 'Nudge'), h('kbd', null, 'Arrows (Shift = 10px)'),
      h('span', null, 'Duplicate while dragging'), h('kbd', null, isMac ? '⌥ drag' : 'Alt + drag'),
      h('span', null, 'Constrain'), h('kbd', null, 'Shift while drawing/moving')));
    modal({ title: 'Keyboard Shortcuts', body, width: 720, buttons: [{ label: 'Close', primary: true }] });
  }

  private about() {
    modal({
      title: 'About Celerity', width: 460,
      body: h('div', { class: 'about' },
        h('div', { class: 'about-logo' }, 'Ce'),
        h('p', null, h('b', null, 'Celerity'), ' — a fast, free 2D animation studio.'),
        h('p', { class: 'dim' }, 'Opens and saves .fla (XFL) documents, publishes SWF, and exports video, GIF, PNG sequences, SVG and sprite sheets.'),
        h('p', { class: 'dim' }, `Running in ${isElectron ? 'desktop' : 'browser'} mode.`)),
      buttons: [{ label: 'OK', primary: true }],
    });
  }

  private preferences() {
    modal({
      title: 'Preferences', width: 460,
      body: h('div', { class: 'form' },
        row('', checkbox('Snap to objects', ui.snap, (v) => setUI('snap', v))),
        row('', checkbox('Show grid', ui.showGrid, (v) => setUI('showGrid', v))),
        row('', checkbox('Loop playback', ui.loop, (v) => setUI('loop', v))),
        row('Onion skin before', numField({ value: ui.onionBefore, min: 0, max: 20, digits: 0, onChange: (v) => setUI('onionBefore', v) }), 'frames'),
        row('Onion skin after', numField({ value: ui.onionAfter, min: 0, max: 20, digits: 0, onChange: (v) => setUI('onionAfter', v) }), 'frames'),
        row('Pencil mode', (() => { const s = h('select') as HTMLSelectElement; for (const [v, l] of [['smooth', 'Smooth'], ['straighten', 'Straighten'], ['ink', 'Ink']]) s.append(h('option', { value: v, selected: ui.pencilMode === v }, l)); s.addEventListener('change', () => setUI('pencilMode', s.value as typeof ui.pencilMode)); return s; })())),
      buttons: [{ label: 'Close', primary: true }],
    });
  }
}
