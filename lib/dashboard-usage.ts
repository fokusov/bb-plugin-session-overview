import type { ActivityEvent } from "./dashboard-activity.ts";
import type { DashboardThread } from "./dashboard-types.ts";
import type { AgentEvent } from "./session-agents.ts";

export const usageSnapshotEventTypes = [
  "thread/tokenUsage/updated", "thread/contextWindowUsage/updated", "thread/context/cleared",
] as const;
export const historyEventTypes = ["thread/tokenUsage/updated", "thread/context/cleared", "turn/completed"] as const;

export function summarizeThreadHistory(rows: readonly AgentEvent[], thread: DashboardThread, reviewer: boolean) {
  const history = new Map(rows.filter((row) => row.threadId === thread.id).map((row) => [row.seq, row]));
  const events: ActivityEvent[] = [];
  const turns = new Map<string, { turnId: string; tokens: number; at: number }>();
  const completed = new Set<string>();
  let previous: { providerThreadId: string; total: number } | null = null;
  let latest: number | null = null;
  let undated = 0;
  let resets = 0;
  const title = thread.title || thread.titleFallback || thread.id;
  const emit = (row: AgentEvent, metric: "turns" | "reviews" | "tokens", detail: string, amount?: number) => {
    events.push({
      id: `${thread.id}:${row.seq}:${metric}`, projectId: thread.projectId, threadId: thread.id,
      metric, source: "agent", at: row.createdAt, title, detail, amount,
      environmentId: thread.environmentId, commitHash: null,
    });
  };

  for (const row of [...history.values()].sort((a, b) => a.seq - b.seq)) {
    const turnId = row.scope.kind === "turn" ? row.scope.turnId : null;
    if (row.type === "turn/completed" && turnId && !completed.has(turnId)) {
      completed.add(turnId);
      const labels = { completed: "Завершён", interrupted: "Прерван", failed: "Ошибка" } as const;
      emit(row, "turns", labels[row.data.status]);
      if (reviewer && row.data.status === "completed") emit(row, "reviews", "Ход рецензента завершён");
      continue;
    }
    if (row.type === "thread/context/cleared") {
      if (previous) resets++;
      previous = null;
      latest = null;
      undated = 0;
      continue;
    }
    if (row.type !== "thread/tokenUsage/updated") continue;
    const total = row.data.tokenUsage.total.totalTokens;
    if (!Number.isSafeInteger(total) || total < 0) continue;
    const providerThreadId = row.data.providerThreadId;
    if (previous && previous.providerThreadId === providerThreadId && total >= previous.total) {
      const delta = total - previous.total;
      if (delta > 0) {
        emit(row, "tokens", `${delta.toLocaleString("ru-RU")} токенов${turnId ? ` · ход ${turnId}` : ""}`, delta);
        if (turnId) {
          const turn = turns.get(turnId);
          turns.set(turnId, { turnId, tokens: (turn?.tokens ?? 0) + delta, at: row.createdAt });
        }
      }
    } else {
      if (previous) resets++;
      undated = total;
    }
    previous = { providerThreadId, total };
    latest = total;
  }
  const unattributedTurnTokens = events.filter((event) => event.metric === "tokens").reduce((sum, event) => sum + (event.amount ?? 0), 0)
    - [...turns.values()].reduce((sum, turn) => sum + turn.tokens, 0);
  return { events, turns: [...turns.values()], latest, undated, resets, unattributedTurnTokens, reviewer, title, threadId: thread.id };
}

export type ThreadUsageHistory = ReturnType<typeof summarizeThreadHistory>;

export interface ProjectUsageHistory {
  threads: ThreadUsageHistory[];
  scanned: number;
  total: number;
  incomplete: number;
  reviewerMetadata: boolean;
}
