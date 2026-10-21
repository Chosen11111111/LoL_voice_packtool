/**
 * XXH3-64 哈希(纯 TypeScript, 零依赖)。
 *
 * 为什么要自己写: 英雄联盟资源包(WAD)的每个条目都有一个内容校验值
 * (条目表 [+24] 那 8 字节), 实测就是 xxh3_64(压缩后的数据)。
 * 换掉条目内容却不更新它, 游戏会直接判定 "Installation is corrupt"。
 * Node 内置的 crypto 没有 xxh3, 项目又要求零运行时依赖, 所以按官方规范实现一份。
 *
 * 规范: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 * 这里的实现以 xxhash 官方 Python/C 库的输出为基准逐条比对过(见 tests/xxh3.test.ts)。
 */

const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;

const PRIME32_1 = 0x9e3779b1n;
const PRIME32_2 = 0x85ebca77n;
const PRIME32_3 = 0xc2b2ae3dn;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const PRIME_MX1 = 0x165667919e3779f9n;
const PRIME_MX2 = 0x9fb21c651e98df25n;

/** 默认密钥(192 字节)。 */
const SECRET = Buffer.from(
  "b8fe6c3923a44bbe7c01812cf721ad1c" +
    "ded46de9839097db7240a4a4b7b3671f" +
    "cb79e64eccc0e578825ad07dccff7221" +
    "b8084674f743248ee03590e6813a264c" +
    "3c2852bb91c300cb88d0658b1b532ea3" +
    "71644897a20df94e3819ef46a9deacd8" +
    "a8fa763fe39c343ff9dcbbc7c70b4f1d" +
    "8a51e04bcdb45931c89f7ec9d9787364" +
    "eac5ac8334d3ebc3c581a0fffa1363eb" +
    "170ddd51b7f0da49d316552629d4689e" +
    "2b16be587d47a1fc8ff8b8d17ad031ce" +
    "45cb3a8f95160428afd7fbcabb4b407e",
  "hex"
);

const SECRET_SIZE = SECRET.length;
const STRIPE_LEN = 64;
const SECRET_CONSUME_RATE = 8;
const ACC_NB = 8;
const SECRET_MERGEACCS_START = 11;

const STRIPES_PER_BLOCK = Math.floor((SECRET_SIZE - STRIPE_LEN) / SECRET_CONSUME_RATE);
const BLOCK_LEN = STRIPE_LEN * STRIPES_PER_BLOCK;

const ACC_INIT: bigint[] = [
  PRIME32_3,
  PRIME64_1,
  PRIME64_2,
  PRIME64_3,
  PRIME64_4,
  PRIME32_2,
  PRIME64_5,
  PRIME32_1
];

const u64 = (v: bigint): bigint => v & MASK64;

function rotl64(v: bigint, shift: bigint): bigint {
  return u64((v << shift) | (v >> (64n - shift)));
}

function swap64(v: bigint): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i += 1) {
    out = (out << 8n) | ((v >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

function swap32(v: number): number {
  return ((v << 24) | ((v << 8) & 0x00ff0000) | ((v >>> 8) & 0x0000ff00) | (v >>> 24)) >>> 0;
}

function readLE32(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at);
}

function readLE64(buf: Buffer, at: number): bigint {
  return buf.readBigUInt64LE(at);
}

function avalanche(h0: bigint): bigint {
  let h = u64(h0);
  h ^= h >> 37n;
  h = u64(h * PRIME_MX1);
  h ^= h >> 32n;
  return u64(h);
}

function avalanche64(h0: bigint): bigint {
  let h = u64(h0);
  h ^= h >> 33n;
  h = u64(h * PRIME64_2);
  h ^= h >> 29n;
  h = u64(h * PRIME64_3);
  h ^= h >> 32n;
  return u64(h);
}

function rrmxmx(h0: bigint, len: number): bigint {
  let h = u64(h0);
  h ^= rotl64(h, 49n) ^ rotl64(h, 24n);
  h = u64(h * PRIME_MX2);
  h ^= (h >> 35n) + BigInt(len);
  h = u64(h * PRIME_MX2);
  h ^= h >> 28n;
  return u64(h);
}

/** 64x64 -> 128 乘法, 高低 64 位异或折叠。 */
function mul128Fold64(a: bigint, b: bigint): bigint {
  const product = u64(a) * u64(b);
  const low = product & MASK64;
  const high = (product >> 64n) & MASK64;
  return u64(low ^ high);
}

function mix16B(input: Buffer, inputAt: number, secretAt: number, seed: bigint): bigint {
  const lo = readLE64(input, inputAt);
  const hi = readLE64(input, inputAt + 8);
  const a = u64(lo ^ u64(readLE64(SECRET, secretAt) + seed));
  const b = u64(hi ^ u64(readLE64(SECRET, secretAt + 8) - seed));
  return mul128Fold64(a, b);
}

function len0to16(input: Buffer, len: number, seed: bigint): bigint {
  if (len > 8) {
    const bitflip1 = u64(readLE64(SECRET, 24) ^ readLE64(SECRET, 32));
    const bitflip1b = u64(bitflip1 + seed);
    const bitflip2 = u64(readLE64(SECRET, 40) ^ readLE64(SECRET, 48));
    const bitflip2b = u64(bitflip2 - seed);
    const lo = u64(readLE64(input, 0) ^ bitflip1b);
    const hi = u64(readLE64(input, len - 8) ^ bitflip2b);
    let acc = u64(BigInt(len) + swap64(lo));
    acc = u64(acc + hi);
    acc = u64(acc + mul128Fold64(lo, hi));
    return avalanche(acc);
  }
  if (len >= 4) {
    const seeded = u64(seed ^ (BigInt(swap32(Number(seed & MASK32))) << 32n));
    const input1 = readLE32(input, 0);
    const input2 = readLE32(input, len - 4);
    const bitflip = u64(readLE64(SECRET, 8) ^ readLE64(SECRET, 16));
    const bitflip2 = u64(bitflip - seeded);
    const input64 = u64((BigInt(input2) + (BigInt(input1) << 32n)) & MASK64);
    return rrmxmx(u64(input64 ^ bitflip2), len);
  }
  if (len > 0) {
    const c1 = BigInt(input[0]!);
    const c2 = BigInt(input[len >> 1]!);
    const c3 = BigInt(input[len - 1]!);
    const combined = ((c1 << 16n) | (c2 << 24n) | c3 | (BigInt(len) << 8n)) & 0xffffffffn;
    const bitflip = u64(BigInt((readLE32(SECRET, 0) ^ readLE32(SECRET, 4)) >>> 0) + seed);
    return avalanche64(u64(combined ^ bitflip));
  }
  return avalanche64(u64(seed ^ u64(readLE64(SECRET, 56) ^ readLE64(SECRET, 64))));
}

function len17to128(input: Buffer, len: number, seed: bigint): bigint {
  let acc = u64(BigInt(len) * PRIME64_1);
  if (len > 32) {
    if (len > 64) {
      if (len > 96) {
        acc = u64(acc + mix16B(input, 48, 96, seed));
        acc = u64(acc + mix16B(input, len - 64, 112, seed));
      }
      acc = u64(acc + mix16B(input, 32, 64, seed));
      acc = u64(acc + mix16B(input, len - 48, 80, seed));
    }
    acc = u64(acc + mix16B(input, 16, 32, seed));
    acc = u64(acc + mix16B(input, len - 32, 48, seed));
  }
  acc = u64(acc + mix16B(input, 0, 0, seed));
  acc = u64(acc + mix16B(input, len - 16, 16, seed));
  return avalanche(acc);
}

function len129to240(input: Buffer, len: number, seed: bigint): bigint {
  let acc = u64(BigInt(len) * PRIME64_1);
  const rounds = Math.floor(len / 16);
  for (let i = 0; i < 8; i += 1) acc = u64(acc + mix16B(input, i * 16, i * 16, seed));
  acc = avalanche(acc);
  for (let i = 8; i < rounds; i += 1) acc = u64(acc + mix16B(input, i * 16, (i - 8) * 16 + 3, seed));
  // 规范: secret + XXH3_SECRET_SIZE_MIN(136) - XXH3_MIDSIZE_LASTOFFSET(17) = 119
  acc = u64(acc + mix16B(input, len - 16, 119, seed));
  return avalanche(acc);
}

function accumulate512(acc: bigint[], input: Buffer, inputAt: number, secretAt: number): void {
  for (let i = 0; i < ACC_NB; i += 1) {
    const dataVal = readLE64(input, inputAt + i * 8);
    const dataKey = u64(dataVal ^ readLE64(SECRET, secretAt + i * 8));
    const lo = dataKey & MASK32;
    const hi = dataKey >> 32n;
    acc[i ^ 1] = u64(acc[i ^ 1]! + dataVal);
    acc[i] = u64(acc[i]! + u64(lo * hi));
  }
}

function scrambleAcc(acc: bigint[], secretAt: number): void {
  for (let i = 0; i < ACC_NB; i += 1) {
    let a = acc[i]!;
    a ^= a >> 47n;
    a ^= readLE64(SECRET, secretAt + i * 8);
    a = u64(a * PRIME32_1);
    acc[i] = a;
  }
}

function accumulateStripe(acc: bigint[], input: Buffer, at: number, stripes: number): void {
  for (let n = 0; n < stripes; n += 1) {
    accumulate512(acc, input, at + n * STRIPE_LEN, n * SECRET_CONSUME_RATE);
  }
}

function mergeAccs(acc: bigint[], start: bigint): bigint {
  let result = start;
  for (let i = 0; i < 4; i += 1) {
    const a = u64(acc[i * 2]! ^ readLE64(SECRET, SECRET_MERGEACCS_START + i * 16));
    const b = u64(acc[i * 2 + 1]! ^ readLE64(SECRET, SECRET_MERGEACCS_START + i * 16 + 8));
    result = u64(result + mul128Fold64(a, b));
  }
  return avalanche(result);
}

function hashLong(input: Buffer, len: number): bigint {
  const acc = ACC_INIT.slice();
  const nbBlocks = Math.floor((len - 1) / BLOCK_LEN);
  for (let n = 0; n < nbBlocks; n += 1) {
    accumulateStripe(acc, input, n * BLOCK_LEN, STRIPES_PER_BLOCK);
    scrambleAcc(acc, SECRET_SIZE - STRIPE_LEN);
  }

  const done = nbBlocks * BLOCK_LEN;
  const nbStripes = Math.floor((len - 1 - done) / STRIPE_LEN);
  accumulateStripe(acc, input, done, nbStripes);

  // 规范里的 "last stripe": 从输入末尾倒着取一条, 用密钥末尾往前 7 字节的位置
  accumulate512(acc, input, len - STRIPE_LEN, SECRET_SIZE - STRIPE_LEN - 7);

  return mergeAccs(acc, u64(BigInt(len) * PRIME64_1));
}

/** 计算 xxh3_64 哈希, 返回无符号 64 位整数。 */
export function xxh3_64(input: Buffer, seed = 0n): bigint {
  const len = input.length;
  const s = u64(seed);
  if (len <= 16) return u64(len0to16(input, len, s));
  if (len <= 128) return u64(len17to128(input, len, s));
  if (len <= 240) return u64(len129to240(input, len, s));
  return u64(hashLong(input, len));
}
