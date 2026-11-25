/**
 * Cost attribution for project tasks.
 *
 * Contract rules, kept explicit so measured sums reconcile:
 * - a thread contributes its own latest cumulative provider snapshot once;
 * - a thread attached to several tasks is counted under one task only: the
 *   earliest attachment wins, then the lowest task key;
 * - threads without a task link stay visible under "Без задачи";
 * - subtasks roll up into their parent, and every task row keeps its own sum;
 * - threads without a snapshot and failed reads are coverage, never zero usage.
 */

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface CostThread {
  threadId: string;
  title: string;
  parentThreadId: string | null;
  providerId: string | null;
  modelId: string | null;
  usage: (TokenCounts & { at: number }) | null;
  /** Tokens reported for the latest turn only; null when the provider omits it. */
  lastTurnTokens: number | null;
  cost: { amount: number; currency: string; estimated: boolean } | null;
  status: "reported" | "unreported" | "error";
}

export interface TaskLink {
  taskId: string;
  threadId: string;
  attachedAt: number;
}

export interface CostTask {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  parentTaskId: string | null;
  updatedAt: number;
}

export interface CostTaskRow {
  task: CostTask;
  own: TokenCounts;
  total: TokenCounts;
  threads: CostThread[];
  children: CostTaskRow[];
}

export interface ProviderModelUsage extends TokenCounts {
  providerId: string | null;
  modelId: string | null;
  threads: number;
}

export interface CostSummary {
  tasks: CostTaskRow[];
  unassigned: { threads: CostThread[]; total: TokenCounts };
  totals: TokenCounts;
  duplicateLinks: number;
  orphanLinks: number;
  coverage: {
    threads: number;
    reported: number;
    unreported: number;
    failed: number;
    linkedThreads: number;
  };
  byProviderModel: ProviderModelUsage[];
  /** Sum of latest snapshots; provider resets may cut earlier history. */
  totalIsLowerBound: boolean;
}

export const emptyTokens: TokenCounts = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function usageOf(thread: CostThread): TokenCounts {
  if (!thread.usage) return emptyTokens;
  const { at: _at, ...counts } = thread.usage;
  return counts;
}

export function summarizeTaskCost(
  tasks: readonly CostTask[],
  links: readonly TaskLink[],
  threads: readonly CostThread[],
): CostSummary {
  const threadById = new Map(threads.map((thread) => [thread.threadId, thread]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const linksByThread = new Map<string, TaskLink[]>();
  for (const link of links) {
    if (!threadById.has(link.threadId)) continue;
    const rows = linksByThread.get(link.threadId) ?? [];
    rows.push(link);
    linksByThread.set(link.threadId, rows);
  }

  const threadTask = new Map<string, string>();
  let duplicateLinks = 0;
  let orphanLinks = 0;
  for (const [threadId, rows] of linksByThread) {
    const valid = rows.filter((link) => taskById.has(link.taskId));
    orphanLinks += rows.length - valid.length;
    if (valid.length === 0) continue;
    const ordered = valid.slice().sort((a, b) =>
      a.attachedAt - b.attachedAt || (taskById.get(a.taskId)!.key.localeCompare(taskById.get(b.taskId)!.key)));
    threadTask.set(threadId, ordered[0].taskId);
    duplicateLinks += ordered.length - 1;
  }

  const rowsById = new Map<string, CostTaskRow>();
  for (const task of tasks) {
    rowsById.set(task.id, { task, own: emptyTokens, total: emptyTokens, threads: [], children: [] });
  }
  const roots: CostTaskRow[] = [];
  for (const row of rowsById.values()) {
    const parent = row.task.parentTaskId ? rowsById.get(row.task.parentTaskId) : undefined;
    if (parent && parent !== row) parent.children.push(row);
    else roots.push(row);
  }

  const unassignedThreads: CostThread[] = [];
  let totals = emptyTokens;
  for (const thread of threads) {
    const counts = usageOf(thread);
    totals = addTokens(totals, counts);
    const taskId = threadTask.get(thread.threadId);
    if (!taskId) {
      unassignedThreads.push(thread);
      continue;
    }
    const row = rowsById.get(taskId);
    if (!row) {
      unassignedThreads.push(thread);
      continue;
    }
    row.own = addTokens(row.own, counts);
    row.threads.push(thread);
  }

  const rollup = (row: CostTaskRow): TokenCounts => {
    row.children.sort((a, b) => a.task.key.localeCompare(b.task.key));
    let total = row.own;
    for (const child of row.children) total = addTokens(total, rollup(child));
    row.threads.sort((a, b) => (b.usage?.totalTokens ?? -1) - (a.usage?.totalTokens ?? -1));
    row.total = total;
    return total;
  };
  roots.sort((a, b) => b.total.totalTokens - a.total.totalTokens || a.task.key.localeCompare(b.task.key));
  for (const root of roots) rollup(root);

  const providerModels = new Map<string, ProviderModelUsage>();
  for (const thread of threads) {
    if (!thread.usage) continue;
    const key = `${thread.providerId ?? ""}\u0000${thread.modelId ?? ""}`;
    const current = providerModels.get(key) ?? {
      providerId: thread.providerId,
      modelId: thread.modelId,
      threads: 0,
      ...emptyTokens,
    };
    const counts = usageOf(thread);
    providerModels.set(key, {
      providerId: current.providerId,
      modelId: current.modelId,
      threads: current.threads + 1,
      inputTokens: current.inputTokens + counts.inputTokens,
      outputTokens: current.outputTokens + counts.outputTokens,
      cachedInputTokens: current.cachedInputTokens + counts.cachedInputTokens,
      totalTokens: current.totalTokens + counts.totalTokens,
    });
  }

  return {
    tasks: roots,
    unassigned: { threads: unassignedThreads, total: unassignedThreads.reduce((sum, thread) => addTokens(sum, usageOf(thread)), emptyTokens) },
    totals,
    duplicateLinks,
    orphanLinks,
    coverage: {
      threads: threads.length,
      reported: threads.filter(({ status }) => status === "reported").length,
      unreported: threads.filter(({ status }) => status === "unreported").length,
      failed: threads.filter(({ status }) => status === "error").length,
      linkedThreads: threadTask.size,
    },
    byProviderModel: [...providerModels.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    totalIsLowerBound: true,
  };
}

export function formatTokens(value: number | null | undefined): string {
  return value == null ? "Недоступно" : new Intl.NumberFormat("ru-RU").format(value);
}
