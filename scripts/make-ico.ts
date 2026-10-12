/**
 * 从 assets/ico/voicepack-icon-512.png 生成规范的 assets/ico/voicepack.ico。
 *
 * 为什么需要它: Windows 加载图标用的是 LoadImageW(IMAGE_ICON), 托盘图标也走它。
 * 它对**小尺寸的 PNG 压缩条目**支持很差 —— 加载会失败, 而托盘库又会把这个失败
 * 静默吞掉, 表现就是"图标怎么都不出现"。所以小尺寸必须用 BMP/DIB(未压缩),
 * 只有 128/256 这种大尺寸才用 PNG 压缩(这是 Windows 自己的惯例)。
 *
 * 用法: node scripts/make-ico.ts
 */
import fs from "node:fs/promises";
import zlib from "node:zlib";

const source = "assets/ico/voicepack-icon-512.png";
const target = "assets/ico/voicepack.ico";
// 小尺寸用 BMP, 大尺寸用 PNG
const dibSizes = [16, 24, 32, 48, 64];
const pngSizes = [128, 256];

/** 解码 PNG -> RGBA。 */
function decodePng(buf: Buffer) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * bpp;
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
    const filter = raw[pos]; pos += 1;
    const row = raw.subarray(pos, pos + stride); pos += stride;
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  return { px, width, height, bpp, stride };
}

/** 按 alpha 加权缩放到 size×size, 返回 RGBA。 */
function resize(px: Buffer, width: number, height: number, stride: number, size: number) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = (x * width / size) | 0;
      const x1 = Math.max(((x + 1) * width / size) | 0, x0 + 1);
      const y0 = (y * height / size) | 0;
      const y1 = Math.max(((y + 1) * height / size) | 0, y0 + 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = sy * stride + sx * 4;
          const alpha = px[i + 3];
          r += px[i] * alpha; g += px[i + 1] * alpha; b += px[i + 2] * alpha;
          a += alpha; n += 1;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = (r / a) | 0; out[o + 1] = (g / a) | 0; out[o + 2] = (b / a) | 0; }
      out[o + 3] = n > 0 ? (a / n) | 0 : 0;
    }
  }
  return out;
}

/** RGBA -> ICO 里的 BMP(DIB) 数据: 40 字节头 + 自下而上的 BGRA + 1bpp AND 掩码。 */
function toDib(rgba: Buffer, size: number) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度是两倍: XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const xor = Buffer.alloc(size * size * 4);
  const maskRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4; // 自下而上
      xor[dst] = rgba[src + 2];     // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src];     // R
      xor[dst + 3] = rgba[src + 3]; // A
      if (rgba[src + 3] < 128) {
        const row = (size - 1 - y) * maskRow;
        and[row + (x >> 3)] |= 0x80 >> (x & 7); // 1 = 透明
      }
    }
  }
  return Buffer.concat([header, xor, and]);
}

/** RGBA -> PNG(用于大尺寸条目)。 */
function toPng(rgba: Buffer, size: number) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const png = await fs.readFile(source);
const { px, width, height, stride } = decodePng(png);
console.log("源图: " + width + "x" + height);

const images = [
  ...dibSizes.map((size) => ({ size, data: toDib(resize(px, width, height, stride, size), size), kind: "BMP" })),
  ...pngSizes.map((size) => ({ size, data: toPng(resize(px, width, height, stride, size), size), kind: "PNG" }))
];

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = Buffer.alloc(images.length * 16);
let offset = 6 + images.length * 16;
images.forEach((image, i) => {
  const o = i * 16;
  entries[o] = image.size >= 256 ? 0 : image.size;
  entries[o + 1] = image.size >= 256 ? 0 : image.size;
  entries[o + 2] = 0;
  entries[o + 3] = 0;
  entries.writeUInt16LE(1, o + 4);  // planes: 必须是 1(之前那份是 0)
  entries.writeUInt16LE(32, o + 6);
  entries.writeUInt32LE(image.data.length, o + 8);
  entries.writeUInt32LE(offset, o + 12);
  offset += image.data.length;
});
const ico = Buffer.concat([header, entries, ...images.map((image) => image.data)]);
await fs.writeFile(target, ico);
console.log("已写出 " + target + "  " + (ico.length / 1024).toFixed(1) + " KB");
console.log("条目: " + images.map((image) => image.size + "(" + image.kind + ")").join(", "));
