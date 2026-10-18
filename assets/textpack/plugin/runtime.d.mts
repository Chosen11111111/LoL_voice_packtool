/** runtime.mjs 的类型声明(它本身是纯 JS —— 要能直接塞进加载器, 也要能在 Node 里被测试)。 */

export declare const CJK: RegExp;
export declare const SKIP_TAGS: string[];
export declare const DEFAULT_SKIP_SELECTORS: string[];

export declare function translate(
  text: string,
  dict: Record<string, string>,
  patterns: [RegExp, string][]
): string | null;

export declare function isCollectable(text: string, dict: Record<string, string>, maxLength: number): boolean;

export interface TextReplacerOptions {
  dict?: Record<string, string>;
  patterns?: [RegExp, string][];
  collect?: boolean;
  maxLength?: number;
  skipSelectors?: string[];
  storageKey?: string;
}

export interface TextReplacer {
  /** 还在工作吗(出错时会自动变 false)。 */
  readonly on: boolean;
  off(): string;
  on_(): string;
  stats(): { replaced: number; scanned: number; failed: number; error: string; collected: number };
  /** 导出没翻译到的中文清单。 */
  dump(): string[];
  clear(): string;
}

export declare function createTextReplacer(options: TextReplacerOptions): TextReplacer;
