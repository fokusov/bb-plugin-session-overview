export interface TokenThread {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
}

export interface TokenThreadSummary extends TokenThread {
  totalTokens: number | null;
  status: "reported" | "unreported" | "error";
}

export interface ProjectTokenSummary {
  totalTokens: number;
  threadsScanned: number;
  reportedThreads: number;
  unreportedThreads: number;
  failedThreads: number;
  historyComplete: boolean;
  threads: TokenThreadSummary[];
}

export interface TokenUsageSnapshot {
  sequence: number;
  totalTokens: number;
}

export function latestTokenUsageTotal(snapshots: readonly TokenUsageSnapshot[]): number | null {
  let latest: TokenUsageSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (!latest || snapshot.sequence > latest.sequence) latest = snapshot;
  }
  return latest?.totalTokens ?? null;
}

/** Sum one latest cumulative total per root thread; never add snapshots together. */
export function summarizeProjectTokens(
  threads: readonly TokenThread[],
  latestTotalByThread: ReadonlyMap<string, number>,
  failedThreadIds: ReadonlySet<string>,
  historyComplete: boolean,
): ProjectTokenSummary {
  const rows = threads.map((thread): TokenThreadSummary => {
    const totalTokens = latestTotalByThread.get(thread.id);
    if (totalTokens !== undefined) return { ...thread, totalTokens, status: "reported" };
    if (failedThreadIds.has(thread.id)) return { ...thread, totalTokens: null, status: "error" };
    return { ...thread, totalTokens: null, status: "unreported" };
  });
  return {
    totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
    threadsScanned: rows.length,
    reportedThreads: rows.filter(({ status }) => status === "reported").length,
    unreportedThreads: rows.filter(({ status }) => status === "unreported").length,
    failedThreads: rows.filter(({ status }) => status === "error").length,
    historyComplete,
    threads: rows,
  };
}
