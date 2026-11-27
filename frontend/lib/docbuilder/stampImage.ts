// Prepares a stamp picture in the browser before upload: scans and exports of
// seals usually sit on an opaque white background, which would hide the text
// under the stamp in Word. «Colour to alpha» against white keeps the ink exactly
// as it looks on paper and makes the paper transparent; then the empty margins
// are trimmed so «size, mm» means the stamp itself.

/** White → transparent, in place (RGBA bytes). Near-white noise (JPEG) becomes fully transparent. */
export function colorToAlpha(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const a = px[i + 3]!;
    const ink = Math.max(255 - r, 255 - g, 255 - b) / 255;
    if (ink < 0.05) {
      px[i + 3] = 0;
      continue;
    }
    px[i] = Math.round(255 - (255 - r) / ink);
    px[i + 1] = Math.round(255 - (255 - g) / ink);
    px[i + 2] = Math.round(255 - (255 - b) / ink);
    px[i + 3] = Math.round(ink * a);
  }
}

/** The smallest box holding every visible pixel (alpha above `min`), or null for an empty picture. */
export function trimBox(px: Uint8ClampedArray, width: number, height: number, min = 10): { x: number; y: number; w: number; h: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3]! > min) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const MAX_SIDE = 1000;

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Any image the browser opens → a trimmed PNG with a transparent background. */
export async function prepareStamp(file: Blob, opts: { removeWhite: boolean } = { removeWhite: true }): Promise<Blob> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Браузер не дав обробити зображення");
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  if (opts.removeWhite) colorToAlpha(data.data);
  const box = trimBox(data.data, w, h) ?? { x: 0, y: 0, w, h };
  const pad = 2;
  const out = document.createElement("canvas");
  out.width = box.w + pad * 2;
  out.height = box.h + pad * 2;
  ctx.putImageData(data, 0, 0);
  out.getContext("2d")!.drawImage(canvas, box.x, box.y, box.w, box.h, pad, pad, box.w, box.h);
  return await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("Не вдалося зберегти PNG"))), "image/png"));
}
