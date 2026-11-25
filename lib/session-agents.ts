import type { useSdk } from "@get-bb/plugin-sdk/app";

type ThreadEvents = ReturnType<typeof useSdk>["threads"]["events"];
export type AgentEvent = Awaited<ReturnType<ThreadEvents["list"]>>[number];

const agentEventTypes = [
  "item/delegation/progress", "item/delegation/completed",
  "thread/contextWindowUsage/updated", "thread/tokenUsage/updated", "thread/context/cleared",
  "item/backgroundTask/progress", "item/backgroundTask/completed",
  "turn/started", "turn/completed", "turn/input/accepted", "client/turn/requested",
] as const;

export async function readAgentEvents(events: Pick<ThreadEvents, "list">, threadId: string, signal: AbortSignal): Promise<AgentEvent[]> {
  const rows = await events.list({ threadId, types: agentEventTypes, order: "desc", limit: "100", signal });
  return rows.filter((event) => event.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
}

export type AgentThread = {
  id: string;
  parentThreadId: string | null;
  title: string | null;
  titleFallback: string | null;
  status: string;
  displayStatus?: string;
  providerId: string;
  environmentId: string | null;
  updatedAt: number;
  projectId?: string;
  orchestration?: OrchestrationMetadata;
  crew?: { address: string; crew: string; role: string };
};

export type OrchestrationMetadata = {
  role: string;
  taskId: string;
  parentThreadId: string;
  runId?: string;
  reviewMode?: string;
};

/** Accept only the published orchestration contract; ignore malformed plugin metadata. */
export function parseOrchestrationMetadata(value: unknown): OrchestrationMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.role !== "string" || !row.role.trim()
    || typeof row.taskId !== "string" || !row.taskId.trim()
    || typeof row.parentThreadId !== "string" || !row.parentThreadId.trim()) return undefined;
  if (row.runId !== undefined && typeof row.runId !== "string") return undefined;
  if (row.reviewMode !== undefined && typeof row.reviewMode !== "string") return undefined;
  return {
    role: row.role,
    taskId: row.taskId,
    parentThreadId: row.parentThreadId,
    ...(typeof row.runId === "string" ? { runId: row.runId } : {}),
    ...(typeof row.reviewMode === "string" ? { reviewMode: row.reviewMode } : {}),
  };
}

export type AgentTreeNode = AgentThread & { children: AgentTreeNode[] };

export type WorkflowAgentAttempt = {
  key: string;
  taskId: string;
  sourceEventId: string;
  sourceThreadId: string;
  label: string;
  index: number;
  attempt: number;
  phaseIndex: number | null;
  phaseTitle: string | null;
  state: "done" | "failed" | "queued" | "running" | "skipped";
  model: string;
  queuedAt: number | null;
  startedAt: number | null;
  lastProgressAt: number;
  durationMs: number | null;
  error: string | null;
  resultPreview: string | null;
};

export type WorkflowAttemptSource = {
  eventId: string;
  threadId: string;
  taskId: string;
  agents: readonly {
    attempt: number;
    durationMs?: number;
    error?: string;
    index: number;
    label: string;
    lastProgressAt: number;
    model: string;
    phaseIndex?: number;
    phaseTitle?: string;
    queuedAt?: number;
    resultPreview?: string;
    startedAt?: number;
    state: WorkflowAgentAttempt["state"];
  }[];
};

export type GraphRunAttemptSource = {
  id: string;
  graphId: string;
  threadId: string | null;
  status: string;
  updatedAt: number;
  visits: Readonly<Record<string, number>>;
  nodeRuns: readonly {
    id: string;
    nodeId: string;
    attempt: number;
    status: string;
    childThreadId: string | null;
    startedAt: number | null;
    endedAt: number | null;
    error: string | null;
  }[];
};

export type GraphRunAttempt = GraphRunAttemptSource["nodeRuns"][number] & {
  key: string;
  runId: string;
  graphId: string;
  sourceThreadId: string | null;
  runStatus: string;
  runUpdatedAt: number;
  nodeVisitCount: number | null;
};

const MAX_PROJECTED_ATTEMPTS = 200;

export function projectGraphRunAttempts(runs: readonly GraphRunAttemptSource[]): GraphRunAttempt[] {
  return runs.flatMap((run) => run.nodeRuns.map((nodeRun) => ({
    ...nodeRun,
    key: `${run.id}:${nodeRun.id}`,
    runId: run.id,
    graphId: run.graphId,
    sourceThreadId: run.threadId,
    runStatus: run.status,
    runUpdatedAt: run.updatedAt,
    nodeVisitCount: typeof run.visits[nodeRun.nodeId] === "number" ? run.visits[nodeRun.nodeId]! : null,
    error: nodeRun.error?.slice(0, 300) ?? null,
  }))).slice(-MAX_PROJECTED_ATTEMPTS);
}

export function projectWorkflowAttempts(events: readonly WorkflowAttemptSource[]): WorkflowAgentAttempt[] {
  const byAttempt = new Map<string, WorkflowAgentAttempt>();
  for (const { eventId, threadId, taskId, agents } of events) {
    for (const agent of agents) {
      const key = `${taskId}:${agent.index}:${agent.attempt}:${agent.phaseIndex ?? "none"}`;
      byAttempt.set(key, {
        key, taskId, sourceEventId: eventId, sourceThreadId: threadId,
        label: agent.label, index: agent.index, attempt: agent.attempt,
        phaseIndex: agent.phaseIndex ?? null, phaseTitle: agent.phaseTitle ?? null,
        state: agent.state, model: agent.model, queuedAt: agent.queuedAt ?? null,
        startedAt: agent.startedAt ?? null, lastProgressAt: agent.lastProgressAt,
        durationMs: agent.durationMs ?? null, error: agent.error?.slice(0, 300) ?? null,
        resultPreview: agent.resultPreview?.slice(0, 500) ?? null,
      });
    }
  }
  return [...byAttempt.values()].slice(-MAX_PROJECTED_ATTEMPTS);
}

export function buildAgentTree(rootId: string, threads: readonly AgentThread[]): AgentTreeNode | null {
  const byId = new Map<string, AgentTreeNode>();
  for (const thread of threads) byId.set(thread.id, { ...thread, children: [] });
  const root = byId.get(rootId);
  if (!root) return null;
  for (const node of byId.values()) {
    if (node.id === rootId) continue;
    const parent = node.parentThreadId ? byId.get(node.parentThreadId) : undefined;
    if (parent) parent.children.push(node);
  }
  const sort = (node: AgentTreeNode) => {
    node.children.sort((a, b) => b.updatedAt - a.updatedAt);
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function formatAgentStatus(status: string): string {
  const labels: Record<string, string> = {
    active: "Работает", starting: "Запускается", pending: "Ожидает",
    stopping: "Останавливается", idle: "Завершил ход", error: "Ошибка",
    "waiting-for-host": "Ожидает машину", provisioning: "Подготовка",
  };
  return labels[status] ?? status;
}

export function formatWorkflowAttemptStatus(status: WorkflowAgentAttempt["state"]): string {
  const labels: Record<WorkflowAgentAttempt["state"], string> = {
    done: "Завершена", failed: "Ошибка", queued: "В очереди", running: "Выполняется", skipped: "Пропущена",
  };
  return labels[status];
}

export function formatTokenCount(value: number | null | undefined): string {
  return value == null ? "Недоступно" : new Intl.NumberFormat("ru-RU").format(value);
}
