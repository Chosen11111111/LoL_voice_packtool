/** 把底层 OSError / 网络错误翻译成界面可直接展示的中文原因。 */

interface ErrnoLike {
  code?: string;
  errno?: number;
  message?: string;
  syscall?: string;
  path?: string;
  cause?: unknown;
}

function asErrnoLike(exc: unknown): ErrnoLike {
  if (exc && typeof exc === "object") return exc as ErrnoLike;
  return { message: String(exc ?? "") };
}

/** 原始错误文本(空则退回类名)。 */
export function errorText(exc: unknown): string {
  const e = asErrnoLike(exc);
  const text = String(e.message ?? "").trim();
  if (text) return text;
  if (exc instanceof Error) return exc.name;
  return String(exc ?? "未知错误");
}

const SHARING_VIOLATION = 32;
const LOCK_VIOLATION = 33;

const CODE_REASONS: Record<string, string> = {
  EPERM: "权限不足或目录不可写",
  EACCES: "权限不足或目录不可写",
  EBUSY: "文件被其他进程占用",
  ETXTBSY: "文件正在运行中",
  ENOENT: "文件或目录不存在",
  ENOTDIR: "路径不是目录",
  EISDIR: "预期是文件却是目录",
  ENOSPC: "磁盘空间不足",
  EROFS: "只读文件系统",
  EMFILE: "打开的文件过多",
  EEXIST: "目标已存在",
  ENAMETOOLONG: "路径过长",
  UNKNOWN: "写入失败(系统拒绝访问)"
};

/** 归类为用户可读的失败原因(用于结果里的 reason 字段)。 */
export function classifyError(exc: unknown): string {
  const e = asErrnoLike(exc);
  const winerror = (e as { winerror?: number }).winerror;
  if (winerror === 5 || e.code === "EPERM" || e.code === "EACCES") return "目标目录不可写";
  if (winerror === SHARING_VIOLATION || winerror === LOCK_VIOLATION) return "文件被其他进程占用";
  if (e.code && CODE_REASONS[e.code]) return CODE_REASONS[e.code];
  if (e.code === "FETCH_FAILED") return "网络请求失败";
  return `写入失败(${errorText(exc)})`;
}

/** 网络/超时类错误(下载器专用)。 */
export function classifyNetworkError(exc: unknown): string {
  const e = asErrnoLike(exc);
  const code = e.code ?? "";
  if (code === "ABORT_ERR" || code === "UND_ERR_ABORTED") return "已取消";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "域名解析失败";
  if (code === "ECONNRESET" || code === "ECONNREFUSED") return "连接被拒绝或中断";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "证书校验失败";
  return errorText(exc);
}

/** 判断错误是否为"取消"。 */
export function isAbortError(exc: unknown): boolean {
  const e = asErrnoLike(exc);
  return e.code === "ABORT_ERR" || e.code === "UND_ERR_ABORTED" || (exc instanceof Error && exc.name === "AbortError");
}

export class AppError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
}
