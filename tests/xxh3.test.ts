/**
 * XXH3-64 的自测。
 *
 * 基准值是 Python 官方 xxhash 库算出来的(tests/fixtures/xxh3-vectors.json),
 * 覆盖规范里的全部分支: 0~3 / 4~8 / 9~16 / 17~128 / 129~240 / >240(多块)。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { xxh3_64 } from "../src/core/xxh3.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

interface Vectors {
  pattern: { len: number; xxh3: string }[];
  random: { data: string; xxh3: string }[];
}

const vectors: Vectors = JSON.parse(await fs.readFile(path.join(here, "fixtures", "xxh3-vectors.json"), "utf8"));

/** 与生成基准值时完全相同的确定性内容。 */
function pattern(n: number): Buffer {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

const hex = (v: bigint): string => v.toString(16).padStart(16, "0");

test("XXH3-64: 与官方库逐条一致(确定性内容, 覆盖所有长度分支)", () => {
  const bad: string[] = [];
  for (const row of vectors.pattern) {
    const got = hex(xxh3_64(pattern(row.len)));
    if (got !== row.xxh3) bad.push(`len=${row.len} 期望 ${row.xxh3} 得到 ${got}`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `共 ${bad.length} 条不一致`);
});

test("XXH3-64: 与官方库一致(随机内容)", () => {
  const bad: string[] = [];
  for (const row of vectors.random) {
    const buf = Buffer.from(row.data, "hex");
    const got = hex(xxh3_64(buf));
    if (got !== row.xxh3) bad.push(`len=${buf.length} 期望 ${row.xxh3} 得到 ${got}`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `共 ${bad.length} 条不一致`);
});

test("XXH3-64: 空输入有确定的哈希值", () => {
  assert.equal(hex(xxh3_64(Buffer.alloc(0))), "2d06800538d394c2");
});

test("XXH3-64: 同样的内容永远得到同样的值(不依赖调用顺序)", () => {
  const a = xxh3_64(pattern(777));
  xxh3_64(pattern(9999));
  const b = xxh3_64(pattern(777));
  assert.equal(a, b);
});
