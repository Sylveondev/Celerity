// Binary assets (bitmaps) are kept out of the document JSON so undo snapshots
// stay small. Library bitmap items reference assets by id.

export interface Asset {
  id: string;
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null;
}

let n = 0;

export class AssetStore {
  private map = new Map<string, Asset>();
  onLoad: (() => void) | null = null;

  get(id: string): Asset | undefined {
    return this.map.get(id);
  }

  all(): Asset[] {
    return [...this.map.values()];
  }

  clear() {
    this.map.clear();
  }

  /** Adds encoded image bytes and decodes them. Resolves when decoded. */
  async add(bytes: Uint8Array, mime: string, id?: string): Promise<Asset> {
    const asset: Asset = { id: id ?? `a${Date.now().toString(36)}${(n++).toString(36)}`, mime, bytes, width: 0, height: 0, image: null };
    this.map.set(asset.id, asset);
    await decodeAsset(asset);
    this.onLoad?.();
    return asset;
  }

  /** Copies an asset from another store under a new id. */
  adopt(a: Asset): Asset {
    const copy: Asset = { ...a, id: `a${Date.now().toString(36)}${(n++).toString(36)}` };
    this.map.set(copy.id, copy);
    return copy;
  }

  /** Adds an already-decoded canvas (e.g. from an FLA .dat bitmap). */
  addCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, bytes: Uint8Array, id?: string): Asset {
    const asset: Asset = {
      id: id ?? `a${Date.now().toString(36)}${(n++).toString(36)}`,
      mime: 'image/png', bytes, width: canvas.width, height: canvas.height,
      image: canvas as HTMLCanvasElement,
    };
    this.map.set(asset.id, asset);
    return asset;
  }
}

export async function decodeAsset(asset: Asset) {
  if (typeof createImageBitmap === 'undefined') return;
  try {
    const blob = new Blob([asset.bytes as BlobPart], { type: asset.mime });
    const img = await createImageBitmap(blob);
    asset.image = img;
    asset.width = img.width;
    asset.height = img.height;
  } catch (e) {
    console.warn('Could not decode image asset', asset.id, e);
  }
}

export function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}
