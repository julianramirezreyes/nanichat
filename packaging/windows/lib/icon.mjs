// Generates the Social Desk application icon (.ico) with Node.js built-ins only: a blue rounded square with a white
// speech bubble and three dots. Each size is a 32-bit BGRA DIB (the most widely supported ICO image format,
// accepted by Inno Setup's SetupIconFile and by Windows shortcuts), anti-aliased by 4x4 supersampling.

const BACKGROUND = [0x25, 0x63, 0xeb]; // RGB #2563eb
const FOREGROUND = [0xff, 0xff, 0xff];
const SAMPLES = 4;

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** Coverage of the background square and of the white bubble at a point in unit coordinates (0..1). */
function shapeAt(x, y) {
  const square = insideRoundedRect(x, y, 0, 0, 1, 1, 0.22);
  if (!square) return 'none';
  const dot = [0.36, 0.5, 0.64].some((dx) => (x - dx) ** 2 + (y - 0.45) ** 2 <= 0.05 ** 2);
  if (dot) return 'background';
  const bubble = insideRoundedRect(x, y, 0.18, 0.24, 0.82, 0.66, 0.1)
    || insideTriangle(x, y, [0.3, 0.6], [0.3, 0.82], [0.5, 0.6]);
  return bubble ? 'foreground' : 'background';
}

/** Returns size*size BGRA pixels, top row first. */
function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let white = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const shape = shapeAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (shape !== 'none') covered++;
          if (shape === 'foreground') white++;
        }
      }
      const offset = (py * size + px) * 4;
      if (covered === 0) continue;
      const mix = white / covered;
      const channel = (index) => Math.round(BACKGROUND[index] * (1 - mix) + FOREGROUND[index] * mix);
      pixels[offset] = channel(2);
      pixels[offset + 1] = channel(1);
      pixels[offset + 2] = channel(0);
      pixels[offset + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

function dibImage(size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR image + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const top = renderPixels(size);
  const xor = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    top.copy(xor, (size - 1 - row) * size * 4, row * size * 4, (row + 1) * size * 4); // DIB rows are bottom-up
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: transparency comes from the alpha channel
  return Buffer.concat([header, xor, mask]);
}

/** @param {readonly number[]} sizes square sizes from 1 to 256 */
export function createIco(sizes) {
  const images = sizes.map((size) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`invalid icon size ${size}`);
    return dibImage(size);
  });
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index];
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}
