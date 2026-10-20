import type { Matrix, Point, Rect } from './types';

export const IDENTITY: Readonly<Matrix> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

export function identity(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
}

/** Returns m1 * m2 (apply m2 first, then m1). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    tx: m1.a * m2.tx + m1.c * m2.ty + m1.tx,
    ty: m1.b * m2.tx + m1.d * m2.ty + m1.ty,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return identity();
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    tx: (m.c * m.ty - m.d * m.tx) * id,
    ty: (m.b * m.tx - m.a * m.ty) * id,
  };
}

export function apply(m: Matrix, x: number, y: number): Point {
  return { x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty };
}

export function applyVec(m: Matrix, x: number, y: number): Point {
  return { x: m.a * x + m.c * y, y: m.b * x + m.d * y };
}

export function translate(tx: number, ty: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, tx, ty };
}

export function scale(sx: number, sy: number): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 };
}

export function rotate(rad: number): Matrix {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, tx: 0, ty: 0 };
}

/** Transform about a pivot point: T(p) * m * T(-p). */
export function aboutPoint(m: Matrix, px: number, py: number): Matrix {
  return multiply(translate(px, py), multiply(m, translate(-px, -py)));
}

export interface Decomposed {
  x: number; y: number;
  scaleX: number; scaleY: number;
  skewX: number; skewY: number; // radians (Flash convention)
}

export function decompose(m: Matrix): Decomposed {
  const scaleX = Math.hypot(m.a, m.b);
  const scaleY = Math.hypot(m.c, m.d);
  const skewY = Math.atan2(m.b, m.a);
  const skewX = Math.atan2(-m.c, m.d);
  return { x: m.tx, y: m.ty, scaleX, scaleY, skewX, skewY };
}

export function compose(d: Decomposed): Matrix {
  return {
    a: d.scaleX * Math.cos(d.skewY),
    b: d.scaleX * Math.sin(d.skewY),
    c: -d.scaleY * Math.sin(d.skewX),
    d: d.scaleY * Math.cos(d.skewX),
    tx: d.x,
    ty: d.y,
  };
}

/** Rotation in degrees as Animate shows it (when skewX == skewY). */
export function rotationDeg(m: Matrix): number {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

export function equals(a: Matrix, b: Matrix, eps = 1e-9): boolean {
  return (
    Math.abs(a.a - b.a) < eps && Math.abs(a.b - b.b) < eps && Math.abs(a.c - b.c) < eps &&
    Math.abs(a.d - b.d) < eps && Math.abs(a.tx - b.tx) < eps && Math.abs(a.ty - b.ty) < eps
  );
}

export function transformRect(m: Matrix, r: Rect): Rect {
  const p1 = apply(m, r.x, r.y);
  const p2 = apply(m, r.x + r.w, r.y);
  const p3 = apply(m, r.x, r.y + r.h);
  const p4 = apply(m, r.x + r.w, r.y + r.h);
  const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
  const minY = Math.min(p1.y, p2.y, p3.y, p4.y);
  const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
  const maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function setCtx(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, m: Matrix) {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.tx, m.ty);
}

export function scaleFactor(m: Matrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

// ---- rect helpers ----
export function emptyRect(): Rect {
  return { x: Infinity, y: Infinity, w: -Infinity, h: -Infinity };
}
export function isEmptyRect(r: Rect): boolean {
  return !(r.w >= 0 && r.h >= 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
}
export function unionRect(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w), btm = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: btm - y };
}
export function inflateRect(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 };
}
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}
export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}
export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
