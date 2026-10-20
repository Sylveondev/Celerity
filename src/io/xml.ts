// Small, fast, dependency-free XML parser and writer (sufficient for XFL).

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string): XNode {
  let i = 0;
  const n = src.length;
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const txt = src.slice(i, lt);
      if (txt.trim()) stack[stack.length - 1].text += decodeEntities(txt);
    }
    i = lt;
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      stack[stack.length - 1].text += src.slice(i + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src[i + 1] === '?' || src[i + 1] === '!') {
      const e = src.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (src[i + 1] === '/') {
      const e = src.indexOf('>', i);
      if (stack.length > 1) stack.pop();
      i = e < 0 ? n : e + 1;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(i + 1, j);
    const node: XNode = { name, attrs: {}, children: [], text: '' };
    // attributes
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === '>' || (src[j] === '/' && src[j + 1] === '>')) break;
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k);
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] === '=') {
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") {
          const e = src.indexOf(q, k + 1);
          node.attrs[an] = decodeEntities(src.slice(k + 1, e < 0 ? n : e));
          j = e < 0 ? n : e + 1;
        } else {
          let e = k;
          while (e < n && !/[\s>]/.test(src[e])) e++;
          node.attrs[an] = decodeEntities(src.slice(k, e));
          j = e;
        }
      } else {
        node.attrs[an] = '';
        j = k;
      }
    }
    stack[stack.length - 1].children.push(node);
    if (src[j] === '/') {
      i = j + 2;
    } else {
      stack.push(node);
      i = j + 1;
    }
  }
  const el = root.children.find((c) => c.name);
  if (!el) throw new Error('Empty XML document');
  return el;
}

export function child(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) if (c.name === name) return c;
  return undefined;
}

export function kids(n: XNode | undefined, name?: string): XNode[] {
  if (!n) return [];
  return name ? n.children.filter((c) => c.name === name) : n.children;
}

/** Path lookup: path("timelines/DOMTimeline") */
export function path(n: XNode | undefined, p: string): XNode | undefined {
  let cur = n;
  for (const part of p.split('/')) cur = child(cur, part);
  return cur;
}

export function attr(n: XNode | undefined, name: string, def = ''): string {
  if (!n) return def;
  const v = n.attrs[name];
  return v === undefined ? def : v;
}

export function num(n: XNode | undefined, name: string, def = 0): number {
  const v = n?.attrs[name];
  if (v === undefined || v === '') return def;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : def;
}

export function bool(n: XNode | undefined, name: string, def = false): boolean {
  const v = n?.attrs[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}

// ---------------- writer ----------------
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

export class XmlWriter {
  private out: string[] = [];
  private depth = 0;
  private stack: string[] = [];

  constructor(declaration = true) {
    if (declaration) this.out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  }

  private attrs(a?: Record<string, string | number | boolean | undefined | null>): string {
    if (!a) return '';
    let s = '';
    for (const k in a) {
      const v = a[k];
      if (v === undefined || v === null) continue;
      s += ` ${k}="${esc(String(v))}"`;
    }
    return s;
  }

  open(name: string, a?: Record<string, string | number | boolean | undefined | null>) {
    this.out.push('  '.repeat(this.depth) + `<${name}${this.attrs(a)}>\n`);
    this.stack.push(name);
    this.depth++;
    return this;
  }

  close() {
    const name = this.stack.pop();
    this.depth--;
    this.out.push('  '.repeat(this.depth) + `</${name}>\n`);
    return this;
  }

  leaf(name: string, a?: Record<string, string | number | boolean | undefined | null>) {
    this.out.push('  '.repeat(this.depth) + `<${name}${this.attrs(a)}/>\n`);
    return this;
  }

  textEl(name: string, text: string, a?: Record<string, string | number | boolean | undefined | null>) {
    const t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    this.out.push('  '.repeat(this.depth) + `<${name}${this.attrs(a)}>${t}</${name}>\n`);
    return this;
  }

  cdataEl(name: string, text: string) {
    this.out.push('  '.repeat(this.depth) + `<${name}><![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]></${name}>\n`);
    return this;
  }

  toString() {
    while (this.stack.length) this.close();
    return this.out.join('');
  }
}
