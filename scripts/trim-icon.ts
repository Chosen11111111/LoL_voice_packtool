/**
 * 把图标外面的"浅色方块底"抠掉, 输出一张背景透明的 PNG。
 * 做法: 亮度高且不饱和的像素才算背景; 并且只从图片**边缘泛洪**过去,
 * 这样六边形**内部**的浅色细节不会被误删。
 */
import fs from "node:fs/promises";
import zlib from "node:zlib";

const src = "assets/ico/voicepack-icon-512.png";
const dst = "assets/ico/voicepack-icon-trim.png";
const buf = await fs.readFile(src);
const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
const bpp = 4, stride = width * bpp;
const chunks: Buffer[] = [];
let off = 8;
while (off + 8 <= buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.subarray(off + 4, off + 8).toString("latin1");
  if (type === "IDAT") chunks.push(buf.subarray(off + 8, off + 8 + len));
  if (type === "IEND") break;
  off += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(chunks));
const px = Buffer.alloc(height * stride);
let pos = 0;
for (let y = 0; y < height; y += 1) {
  const f = raw[pos]; pos += 1;
  const row = raw.subarray(pos, pos + stride); pos += stride;
  const out = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
  for (let x = 0; x < stride; x += 1) {
    const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
    let v = row[x];
    if (f === 1) v += a; else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    out[x] = v & 0xff;
  }
}

const lum = (i: number) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
const sat = (i: number) => {
  const r = px[i], g = px[i + 1], b = px[i + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
// 背景判定: 够亮 + 够灰(浅蓝/白都算)
const isBackground = (i: number) => lum(i) > 0.80 && sat(i) < 0.30;

const removed = new Uint8Array(width * height);
const queue: number[] = [];
for (let x = 0; x < width; x += 1) { queue.push(x, (height - 1) * width + x); }
for (let y = 0; y < height; y += 1) { queue.push(y * width, y * width + width - 1); }
while (queue.length) {
  const p = queue.pop()!;
  const x = p % width, y = (p - x) / width;
  if (x < 0 || y < 0 || x >= width || y >= height) continue;
  if (removed[p]) continue;
  const i = y * stride + x * bpp;
  if (!isBackground(i)) continue;
  removed[p] = 1;
  queue.push(p - 1, p + 1, p - width, p + width);
}

const out = Buffer.from(px);
let kept = 0, cleared = 0, softened = 0;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const p = y * width + x;
    const i = y * stride + x * bpp;
    if (removed[p]) {
      out[i + 3] = 0;
      cleared += 1;
      continue;
    }
    kept += 1;
    // 与已抠掉区域相邻的浅色像素给半透明, 让边缘平滑(否则会留一圈硬边)
    const near =
      (x > 0 && removed[p - 1]) || (x < width - 1 && removed[p + 1]) ||
      (y > 0 && removed[p - width]) || (y < height - 1 && removed[p + width]);
    if (near && isBackground(i)) {
      out[i + 3] = 90;
      softened += 1;
    }
  }
}
console.log("抠掉 " + cleared + " 像素 (" + (cleared / (width * height) * 100).toFixed(1) + "%), 保留 " + kept + ", 羽化 " + softened);

// 写 PNG(全部用 filter 0)
const rawOut = Buffer.alloc(height * (stride + 1));
for (let y = 0; y < height; y += 1) {
  rawOut[y * (stride + 1)] = 0;
  out.subarray(y * stride, (y + 1) * stride).copy(rawOut, y * (stride + 1) + 1);
}
const crcTable: number[] = [];
for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(rawOut, { level: 9 })),
  chunk("IEND", Buffer.alloc(0))
]);
await fs.writeFile(dst, png);
console.log("已写出 " + dst + "  " + (png.length / 1024).toFixed(1) + " KB");
