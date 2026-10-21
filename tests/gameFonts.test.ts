/**
 * 局内字体的识别与规划(纯逻辑, 不碰任何真实客户端文件)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { useSuite } from "./helpers.ts";
import { fontNamesOf, planFontPatches, roleOf, type FontFace } from "../src/packs/gameFonts.ts";

useSuite("gameFonts");

/** 造一个最小可用的 sfnt, 只带 name 表: 用来喂 fontNamesOf。 */
export function makeFakeFont(family: string, full: string): Buffer {
  const strings: Buffer[] = [];
  const records: Buffer[] = [];
  const push = (nameId: number, text: string) => {
    const encoded = Buffer.from(text, "utf16le").swap16();
    records.push((() => {
      const r = Buffer.alloc(12);
      r.writeUInt16BE(3, 0);        // platform = Windows
      r.writeUInt16BE(1, 2);        // encoding = Unicode BMP
      r.writeUInt16BE(0x409, 4);    // language = en-US
      r.writeUInt16BE(nameId, 6);
      r.writeUInt16BE(encoded.length, 8);
      const offset = strings.reduce((sum, b) => sum + b.length, 0);
      r.writeUInt16BE(offset, 10);
      strings.push(encoded);
      return r;
    })());
  };
  push(1, family);
  push(4, full);
  push(16, family);

  const recordBlock = Buffer.concat(records);
  const stringBlock = Buffer.concat(strings);
  const nameHeader = Buffer.alloc(6);
  nameHeader.writeUInt16BE(0, 0);
  nameHeader.writeUInt16BE(records.length, 2);
  nameHeader.writeUInt16BE(6 + recordBlock.length, 4);
  const nameTable = Buffer.concat([nameHeader, recordBlock, stringBlock]);

  const sfnt = Buffer.alloc(12 + 16);
  sfnt.writeUInt32BE(0x00010000, 0);
  sfnt.writeUInt16BE(1, 4);
  sfnt.write("name", 12, "ascii");
  sfnt.writeUInt32BE(28, 20);                       // 表偏移 = 12 + 16
  sfnt.writeUInt32BE(nameTable.length, 24);
  return Buffer.concat([sfnt, nameTable]);
}

const face = (index: number, family: string, full: string): FontFace => ({
  index, family, full, compressed: true, size: 1000, rawSize: 5000
});

test("能读出字体内部的家族名与完整名", () => {
  const font = makeFakeFont("Spiegel", "Spiegel Regular");
  const names = fontNamesOf(font);
  assert.equal(names.family, "Spiegel");
  assert.equal(names.full, "Spiegel Regular");
});

test("读不出来的数据不会抛错, 返回空串", () => {
  assert.deepEqual(fontNamesOf(Buffer.from("not a font at all")), { family: "", full: "" });
  assert.deepEqual(fontNamesOf(Buffer.alloc(0)), { family: "", full: "" });
});

test("能认出一款字体属于哪个语种", () => {
  assert.equal(roleOf("FZLanTingHei-L-GBK"), "cjk");
  assert.equal(roleOf("FZDaHei-B02"), "cjk");
  assert.equal(roleOf("UttumDotum"), "kr");
  assert.equal(roleOf("Spiegel Ja"), "jp-body");
  assert.equal(roleOf("Spiegel"), "latin-body");
  assert.equal(roleOf("Beaufort for LOL"), "latin-body");
  assert.equal(roleOf("Arial"), null);
});

const FACES: FontFace[] = [
  face(1, "FZLanTingHei-L-GBK", "FZLanTingHei-L-GBK"),
  face(2, "FZDaHei-B02", "FZDaHei-B02"),
  face(3, "FZXHYSZK", "FZXHYSZK"),
  face(10, "Spiegel", "Spiegel Regular"),
  face(11, "Spiegel", "Spiegel SemiBold"),
  face(12, "Spiegel", "Spiegel Bold"),
  face(20, "Spiegel Ja", "Spiegel Ja"),
  face(21, "Spiegel Ja", "Spiegel Ja Bold"),
  face(30, "UttumDotum", "UttumDotum")
];

test("中文不需要换字体", () => {
  assert.deepEqual(planFontPatches("zh_CN", FACES), []);
});

test("英语: 三条中文字体分别换成 Spiegel 的常规/半粗/粗体", () => {
  const plan = planFontPatches("en_US", FACES);
  assert.equal(plan.length, 3);
  const byTarget = new Map(plan.map((p) => [p.targetIndex, p.sourceIndex]));
  assert.equal(byTarget.get(1), 10, "常规中文 → Spiegel Regular");
  assert.equal(byTarget.get(3), 11, "细黑 → Spiegel SemiBold");
  assert.equal(byTarget.get(2), 12, "大黑(粗) → Spiegel Bold");
});

test("韩语: 三条中文字体全部换成 UttumDotum", () => {
  const plan = planFontPatches("ko_KR", FACES);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((p) => p.sourceIndex), [30, 30, 30]);
});

test("日语: 换成 Spiegel Ja 对应字重", () => {
  const plan = planFontPatches("ja_JP", FACES);
  const byTarget = new Map(plan.map((p) => [p.targetIndex, p.sourceIndex]));
  assert.equal(byTarget.get(1), 20);
  assert.equal(byTarget.get(2), 21);
});

test("包里没有源字体时不会瞎换", () => {
  const onlyCjk = FACES.filter((f) => roleOf(f.family) === "cjk");
  assert.deepEqual(planFontPatches("en_US", onlyCjk), []);
});
