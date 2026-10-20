// Core document model. Mirrors the XFL (FLA) object model closely so that
// saving/opening .fla files is a near 1:1 mapping.

export interface Matrix {
  a: number; b: number; c: number; d: number; tx: number; ty: number;
}

export interface Point { x: number; y: number }

export interface Rect { x: number; y: number; w: number; h: number }

export interface GradientStop { offset: number; color: string; alpha: number }

export type Fill =
  | { kind: 'solid'; color: string; alpha: number }
  | {
      kind: 'linear' | 'radial';
      stops: GradientStop[];
      // Maps the gradient square (-819.2..819.2 on each axis, Flash convention)
      // into the shape's local space.
      matrix: Matrix;
      spread?: 'pad' | 'reflect' | 'repeat';
    };

export type CapStyle = 'round' | 'butt' | 'square';
export type JoinStyle = 'round' | 'miter' | 'bevel';

export interface Stroke {
  color: string;
  alpha: number;
  width: number;
  caps: CapStyle;
  joints: JoinStyle;
  miter?: number;
}

/**
 * Path data is a flat number array of opcodes followed by their operands:
 *   0 x y                 moveTo
 *   1 x y                 lineTo
 *   2 cx cy x y           quadraticTo
 *   3 c1x c1y c2x c2y x y cubicTo
 *   4                     closePath
 * Path arrays are treated as immutable: edits always create a new array, which
 * lets renderers cache Path2D objects by identity.
 */
export type PathData = number[];

export const OP_M = 0;
export const OP_L = 1;
export const OP_Q = 2;
export const OP_C = 3;
export const OP_Z = 4;

export interface ShapePath {
  fill: Fill | null;
  stroke: Stroke | null;
  d: PathData;
}

export interface ColorTransform {
  rm: number; gm: number; bm: number; am: number; // multipliers
  ro: number; go: number; bo: number; ao: number; // offsets (-255..255)
}

export type ColorEffectMode = 'none' | 'brightness' | 'tint' | 'alpha' | 'advanced';

export interface ColorEffect {
  mode: ColorEffectMode;
  brightness: number;   // -100..100
  tintColor: string;
  tintAmount: number;   // 0..100
  alpha: number;        // 0..100
  advanced: ColorTransform;
}

export type SymbolType = 'graphic' | 'movieclip' | 'button';
export type LoopMode = 'loop' | 'play once' | 'single frame' | 'loop reverse' | 'play once reverse';

interface ElementBase {
  id: string;
  matrix: Matrix;
}

export interface ShapeElement extends ElementBase {
  type: 'shape';
  paths: ShapePath[];
}

export type FilterDef =
  | { type: 'dropShadow'; blurX: number; blurY: number; strength: number; quality: number; color: string; alpha: number; angle: number; distance: number; inner: boolean; knockout: boolean; hideObject: boolean }
  | { type: 'blur'; blurX: number; blurY: number; quality: number }
  | { type: 'glow'; blurX: number; blurY: number; strength: number; quality: number; color: string; alpha: number; inner: boolean; knockout: boolean };

export type BlendMode = 'normal' | 'layer' | 'multiply' | 'screen' | 'lighten' | 'darken' | 'difference' | 'add' | 'subtract' | 'invert' | 'overlay' | 'hardlight';

export interface SymbolInstance extends ElementBase {
  type: 'symbol';
  libraryItem: string;
  symbolType: SymbolType;
  loop: LoopMode;
  firstFrame: number;
  name: string;            // instance name
  color: ColorEffect;
  transformPoint: Point;   // in the symbol's local coordinates
  blendMode?: BlendMode;
  filters?: FilterDef[];   // movie clips and buttons only (like Animate)
}

export interface BitmapInstance extends ElementBase {
  type: 'bitmap';
  libraryItem: string;
}

export interface TextElement extends ElementBase {
  type: 'text';
  text: string;
  font: string;
  size: number;
  color: string;
  alpha: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  width: number;        // 0 = auto width
  lineSpacing: number;  // extra px between lines
  letterSpacing: number;
}

export interface GroupElement extends ElementBase {
  type: 'group';
  children: Element[];
}

export type Element = ShapeElement | SymbolInstance | BitmapInstance | TextElement | GroupElement;

export type TweenType = 'none' | 'classic' | 'shape';

export interface Frame {
  start: number;
  duration: number;
  elements: Element[];
  tween: TweenType;
  ease: number;                       // -100 (in) .. 100 (out)
  rotate: 'auto' | 'none' | 'cw' | 'ccw';
  rotateTimes: number;
  label: string;
  labelType: 'name' | 'comment' | 'anchor';
  script: string;
}

export type LayerType = 'normal' | 'guide' | 'mask' | 'folder';

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  parentId: string | null; // mask or folder this layer belongs to
  visible: boolean;
  locked: boolean;
  outline: boolean;
  color: string;
  open?: boolean;          // folder expanded
  frames: Frame[];         // contiguous from frame 0
}

export interface Timeline {
  name: string;
  layers: Layer[];         // index 0 = top layer
}

export interface SymbolItem {
  kind: 'symbol';
  name: string;            // may contain folder path "Folder/Sub/Name"
  symbolType: SymbolType;
  timeline: Timeline;
  itemID: string;
}

export interface BitmapItem {
  kind: 'bitmap';
  name: string;
  itemID: string;
  assetId: string;         // key into the AssetStore
  width: number;
  height: number;
  smoothing: boolean;
}

export interface FolderItem {
  kind: 'folder';
  name: string;
  itemID: string;
}

export type LibraryItem = SymbolItem | BitmapItem | FolderItem;

export interface Doc {
  width: number;
  height: number;
  fps: number;
  background: string;
  scenes: Timeline[];
  library: LibraryItem[];
}
