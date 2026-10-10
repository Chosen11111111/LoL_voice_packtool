/**
 * 后台任务管理: 一键切换/还原属于长任务, 不能阻塞 HTTP 请求。
 * 每个任务都有 id、进度、结果, 并能被取消; 事件通过订阅者广播给 SSE。
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("tasks");

export type TaskKind =
  | "apply"
  | "restore"
  | "oneclick_apply"
  | "oneclick_restore"
  | "update_check"
  | "update_run"
  | "pack_import"
  | "plugin_install";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskProgress {
  done: number;
  total: number;
  percent: number;
  current: string;
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  progress: TaskProgress;
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: string;
  events: TaskEvent[];
}

export type TaskEvent =
  | { type: "state"; task: TaskSnapshot }
  | { type: "progress"; id: string; progress: TaskProgress }
  | { type: "done"; id: string; status: TaskStatus; result: unknown; error: string }
  | { type: "log"; id: string; line: string };

export interface TaskSnapshot {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  progress: TaskProgress;
  startedAt: number;
  finishedAt: number | null;
  error: string;
  hasResult: boolean;
}

export interface TaskHandle {
  id: string;
  signal: AbortSignal;
  progress: (done: number, total: number, current?: string) => void;
  log: (line: string) => void;
  isCancelled: () => boolean;
}

type Subscriber = (event: TaskEvent) => void;

/** 同一类任务串行: 语音相关任务并发跑会把同一批文件互相覆盖。 */
const EXCLUSIVE_GROUPS: Partial<Record<TaskKind, string>> = {
  apply: "switch",
  restore: "switch",
  oneclick_apply: "switch",
  oneclick_restore: "switch",
  update_run: "update"
};

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly lockedGroups = new Map<string, string>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private broadcast(event: TaskEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        logger.debug(`订阅者异常: ${String((error as Error).message ?? error)}`);
      }
    }
  }

  snapshot(record: TaskRecord): TaskSnapshot {
    return {
      id: record.id,
      kind: record.kind,
      label: record.label,
      status: record.status,
      progress: record.progress,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      error: record.error,
      hasResult: record.result !== undefined && record.result !== null
    };
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()].map((record) => this.snapshot(record)).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  /** 等待任务结束(CLI 用; HTTP 侧不阻塞)。 */
  async waitFor(id: string, timeoutMs = 0): Promise<TaskRecord | null> {
    const record = this.tasks.get(id);
    if (!record) return null;
    while (record.status === "running" || record.status === "pending") {
      if (timeoutMs > 0 && Date.now() - record.startedAt > timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return record;
  }

  /** 当前被占用的小组(界面用来禁用按钮)。 */
  busyGroups(): Record<string, string> {
    return Object.fromEntries(this.lockedGroups);
  }

  isBusy(kind: TaskKind): boolean {
    const group = EXCLUSIVE_GROUPS[kind];
    return group ? this.lockedGroups.has(group) : false;
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    const record = this.tasks.get(id);
    if (!controller || !record || record.status !== "running") return false;
    controller.abort();
    logger.info(`已请求取消任务 ${id}`);
    return true;
  }

  /** 启动任务并直接返回快照(HTTP/CLI 用)。 */
  startSnapshot<T>(kind: TaskKind, label: string, runner: (handle: TaskHandle) => Promise<T>): TaskSnapshot {
    return this.start(kind, label, runner).task;
  }

  /**
   * 启动一个任务。同一互斥组已有任务在跑时直接抛错(界面应先禁用按钮)。
   */
  start<T>(
    kind: TaskKind,
    label: string,
    runner: (handle: TaskHandle) => Promise<T>
  ): { task: TaskSnapshot } {
    const group = EXCLUSIVE_GROUPS[kind];
    if (group && this.lockedGroups.has(group)) {
      throw new Error(`已有任务在进行中(${this.tasks.get(this.lockedGroups.get(group)!)?.label ?? group})，请等待完成后再试。`);
    }
    const id = randomUUID();
    const controller = new AbortController();
    const record: TaskRecord = {
      id,
      kind,
      label,
      status: "running",
      progress: { done: 0, total: 0, percent: 0, current: "" },
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: "",
      events: []
    };
    this.tasks.set(id, record);
    this.controllers.set(id, controller);
    if (group) this.lockedGroups.set(group, id);
    this.broadcast({ type: "state", task: this.snapshot(record) });

    const handle: TaskHandle = {
      id,
      signal: controller.signal,
      progress: (done, total, current = "") => {
        const safeTotal = Math.max(0, Math.trunc(total));
        const safeDone = Math.max(0, Math.trunc(done));
        record.progress = {
          done: safeDone,
          total: safeTotal,
          percent: safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 1000) / 10) : 0,
          current
        };
        this.broadcast({ type: "progress", id, progress: record.progress });
      },
      log: (line) => {
        record.events.push({ type: "log", id, line });
        if (record.events.length > 500) record.events.splice(0, record.events.length - 500);
        this.broadcast({ type: "log", id, line });
      },
      isCancelled: () => controller.signal.aborted
    };

    void (async () => {
      try {
        const result = await runner(handle);
        record.result = result ?? null;
        record.status = controller.signal.aborted ? "cancelled" : "succeeded";
      } catch (error) {
        if (controller.signal.aborted) {
          record.status = "cancelled";
        } else {
          record.status = "failed";
          record.error = String((error as Error).message ?? error);
        }
        logger.warn(`任务 ${kind} 失败: ${record.error}`);
      } finally {
        record.finishedAt = Date.now();
        this.controllers.delete(id);
        if (group && this.lockedGroups.get(group) === id) this.lockedGroups.delete(group);
        this.broadcast({ type: "done", id, status: record.status, result: record.result, error: record.error });
      }
    })();

    return { task: this.snapshot(record) };
  }
}

export const taskManager = new TaskManager();
