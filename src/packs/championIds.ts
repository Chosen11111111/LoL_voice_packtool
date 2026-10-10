/** 大厅选人/禁用语音在客户端资源包里的两个目录名。 */
export const CHAMPION_CHOOSE = "champion-choose-vo";
export const CHAMPION_BAN = "champion-ban-vo";

/** 从文件名列表中提取英雄 ID。 */
export function extractIds(names: string[]): number[] {
  const ids = new Set<number>();
  for (const name of names) {
    const id = Number.parseInt(name.replace(/\.[^.]+$/, ""), 10);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}
