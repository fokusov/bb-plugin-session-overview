/**
 * Read-only dashboard sources.
 *
 * Every source is a published contract of another plugin or of the BB SDK:
 * - BB SDK threads and environments for project work and activity days;
 * - `bb--git.workspaceStatus` for branch and changed files;
 * - `1c-properties.passport` for the configuration passport and source volume;
 * - `1c-properties.platformDashboardV1` for operations, tests and revisions;
 * - `git-history` for commits (optional plugin, read-only RPC);
 * - `tasks` for BB Tasks and thread links;
 * - `openspec-bsl-flow` for OpenSpec changes, BSL Flow stages and blockers.
 *
 * Missing plugins and failed reads return an explicit error; they are never
 * replaced with zero.
 */

import { z } from "zod";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import type { ActivityEvent } from "./dashboard-activity.ts";
import { localDay } from "./dashboard-activity.ts";
import type { CostTask, CostThread, TaskLink } from "./dashboard-cost.ts";
import type { OperationEntry } from "./dashboard-quality.ts";
import { isBuildAction } from "./dashboard-quality.ts";
import type { DashboardThread } from "./dashboard-types.ts";
import type { PassportSnapshot } from "./passport.ts";
import { passportSchema } from "./passport.ts";

type Sdk = ReturnType<typeof useSdk>;
const THREAD_PAGE_SIZE = 200;
export const THREAD_SCAN_LIMIT = 10_000;
const USAGE_THREAD_LIMIT = 250;
const OPERATION_LIMIT = 60;

export interface ReadResult<T> {
  value: T;
  complete: boolean;
  error: string | null;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A slow repository must not block the whole commits load. */
function bounded(signal: AbortSignal, ms = 10_000): AbortSignal {
  if (typeof AbortSignal.any !== "function" || typeof AbortSignal.timeout !== "function") return signal;
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function readDashboardThreads(sdk: Sdk, signal: AbortSignal, projectId?: string): Promise<ReadResult<DashboardThread[]>> {
  const rows: DashboardThread[] = [];
  let offset = 0;
  try {
    for (;;) {
      const page = await sdk.threads.list({
        limit: THREAD_PAGE_SIZE,
        offset,
        includeHidden: false,
        ...(projectId ? { projectId } : {}),
        signal,
      });
      rows.push(...page.map(({ id, projectId: owner, title, titleFallback, status, parentThreadId, updatedAt, environmentId, providerId, runtime }) => ({
        id,
        projectId: owner,
        title,
        titleFallback,
        status,
        displayStatus: runtime?.displayStatus ?? null,
        parentThreadId,
        updatedAt,
        environmentId,
        providerId,
      })));
      if (page.length < THREAD_PAGE_SIZE) return { value: rows, complete: true, error: null };
      offset += page.length;
      if (rows.length >= THREAD_SCAN_LIMIT) return { value: rows.slice(0, THREAD_SCAN_LIMIT), complete: false, error: null };
    }
  } catch (cause) {
    return { value: rows, complete: false, error: message(cause) };
  }
}

export function threadActivityEvents(threads: readonly DashboardThread[]): ActivityEvent[] {
  return threads.map((thread) => ({
    id: `${thread.id}:${localDay(thread.updatedAt)}`,
    projectId: thread.projectId,
    metric: "threads",
    source: "thread",
    at: thread.updatedAt,
    title: thread.title || thread.titleFallback || `Тред ${thread.id.slice(0, 8)}`,
    detail: thread.displayStatus ?? thread.status,
    threadId: thread.id,
    environmentId: thread.environmentId,
    commitHash: null,
  }));
}

const gitRefSchema = z.object({ fullName: z.string(), name: z.string(), kind: z.string(), isHead: z.boolean() });
const commitSchema = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string(),
  authorDate: z.string(),
  committerDate: z.string(),
  subject: z.string(),
  refs: z.array(gitRefSchema),
});
const historyPageSchema = z.object({
  repoName: z.string(),
  currentBranch: z.string().nullable(),
  commits: z.array(commitSchema),
  offset: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  revision: z.string(),
  unavailableReason: z.string().nullable(),
});
const repositoriesSchema = z.object({
  repositories: z.array(z.object({ key: z.string(), name: z.string(), currentBranch: z.string().nullable().optional(), dirtyCount: z.number().nullable().optional() })),
  unavailableReason: z.string().nullable(),
});

/** Commits for a project, one walk per distinct worktree, deduplicated by hash. */
export async function readProjectCommits(
  sdk: Sdk,
  threads: readonly DashboardThread[],
  fromDay: string,
  signal: AbortSignal,
): Promise<ReadResult<ActivityEvent[]>> {
  const latestByEnvironment = new Map<string, DashboardThread>();
  for (const thread of threads) {
    if (!thread.environmentId) continue;
    const current = latestByEnvironment.get(thread.environmentId);
    if (!current || thread.updatedAt > current.updatedAt) latestByEnvironment.set(thread.environmentId, thread);
  }
  const environments = [...latestByEnvironment.entries()].slice(0, 6);
  if (environments.length === 0) return { value: [], complete: true, error: "Нет рабочих окружений с Git" };
  const events: ActivityEvent[] = [];
  const errors: string[] = [];
  const walkedRepositories = new Set<string>();
  const walkedProjects = new Set<string>();
  let complete = true;

  for (const [environmentId, thread] of environments) {
    // Worktrees of one project share the same repository and refs, so one
    // environment per project already exposes the whole commit history.
    if (walkedProjects.has(thread.projectId)) continue;
    walkedProjects.add(thread.projectId);
    try {
      const repositories = repositoriesSchema.parse(await sdk.plugins.callRpc({
        pluginId: "git-history",
        method: "repositories",
        input: { threadId: thread.id },
        outputSchema: repositoriesSchema,
        signal: bounded(signal),
      }));
      if (repositories.unavailableReason) {
        errors.push(`${environmentId}: ${repositories.unavailableReason}`);
        continue;
      }
      for (const repository of repositories.repositories.slice(0, 2)) {
        // git-history reads every ref of the repository, so one walk per
        // repository is enough even when several worktrees share it.
        const repositoryKey = `${thread.projectId}\u0000${repository.name}`;
        if (walkedRepositories.has(repositoryKey)) continue;
        walkedRepositories.add(repositoryKey);
        let offset = 0;
        for (let page = 0; page < 2; page += 1) {
          const history = historyPageSchema.parse(await sdk.plugins.callRpc({
            pluginId: "git-history",
            method: "history",
            input: { threadId: thread.id, repositoryKey: repository.key, offset, limit: 200 },
            outputSchema: historyPageSchema,
            signal: bounded(signal),
          }));
          if (history.unavailableReason) {
            errors.push(`${repository.name}: ${history.unavailableReason}`);
            break;
          }
          let olderThanRange = false;
          for (const commit of history.commits) {
            const at = Date.parse(commit.authorDate);
            if (!Number.isFinite(at)) continue;
            if (localDay(at) < fromDay) {
              olderThanRange = true;
              continue;
            }
            events.push({
              id: `${environmentId}:${commit.hash}`,
              projectId: thread.projectId,
              metric: "commits",
              source: "commit",
              at,
              title: commit.subject,
              detail: `${commit.authorName} · ${repository.name}`,
              threadId: thread.id,
              environmentId,
              commitHash: commit.hash,
            });
          }
          if (!history.hasMore || olderThanRange || history.commits.length === 0) break;
          offset += history.commits.length;
          if (page === 1) complete = false;
        }
      }
    } catch (cause) {
      errors.push(message(cause));
    }
  }
  return { value: events, complete, error: errors.length > 0 ? errors.join("; ") : null };
}

const historyRevisionSchema = z.object({ revision: z.string(), unavailableReason: z.string().nullable() });

/** Current source revision of the project's first repository, used to compare reports with sources. */
export async function readProjectRevision(sdk: Sdk, threads: readonly DashboardThread[], signal: AbortSignal): Promise<string | null> {
  const latest = threads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!latest) return null;
  try {
    const repositories = repositoriesSchema.parse(await sdk.plugins.callRpc({
      pluginId: "git-history",
      method: "repositories",
      input: { threadId: latest.id },
      outputSchema: repositoriesSchema,
      signal: bounded(signal, 5_000),
    }));
    const repository = repositories.repositories[0];
    if (!repository) return null;
    const revision = historyRevisionSchema.parse(await sdk.plugins.callRpc({
      pluginId: "git-history",
      method: "historyRevision",
      input: { threadId: latest.id, repositoryKey: repository.key },
      outputSchema: historyRevisionSchema,
      signal: bounded(signal, 5_000),
    }));
    return revision.unavailableReason ? null : revision.revision;
  } catch {
    return null;
  }
}

const taskListSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), linkedBbProjectId: z.string().nullable() })),
});
const taskSchema = z.object({
  id: z.string(), projectId: z.string(), key: z.string(), title: z.string(), status: z.string(), priority: z.string(),
  dueDate: z.string().nullable(), parentTaskId: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
const taskListAllSchema = z.object({ tasks: z.array(taskSchema) });
const taskThreadsSchema = z.object({
  taskThreads: z.array(z.object({
    id: z.string(), taskId: z.string(), threadId: z.string(), presetName: z.string(), title: z.string(),
    liveStatus: z.enum(["starting", "working", "idle", "completed", "failed"]), attachedAt: z.string(), updatedAt: z.string(),
  })),
});

export interface ProjectTasks {
  tasks: CostTask[];
  links: TaskLink[];
  taskProjectName: string | null;
  complete: boolean;
  error: string | null;
}

export async function readProjectTasks(sdk: Sdk, projectId: string, signal: AbortSignal): Promise<ProjectTasks> {
  try {
    const { projects } = taskListSchema.parse(await sdk.plugins.callRpc({
      pluginId: "tasks", method: "listProjects", input: {}, outputSchema: taskListSchema, signal,
    }));
    const linked = projects.find((project) => project.linkedBbProjectId === projectId) ?? null;
    if (!linked) return { tasks: [], links: [], taskProjectName: null, complete: true, error: null };
    const { tasks } = taskListAllSchema.parse(await sdk.plugins.callRpc({
      pluginId: "tasks", method: "listAllTasks", input: { projectId: linked.id, sort: "manual" }, outputSchema: taskListAllSchema, signal,
    }));
    const links: TaskLink[] = [];
    let complete = true;
    for (const task of tasks.slice(0, 200)) {
      try {
        const { taskThreads } = taskThreadsSchema.parse(await sdk.plugins.callRpc({
          pluginId: "tasks", method: "listTaskThreads", input: { taskId: task.id }, outputSchema: taskThreadsSchema, signal,
        }));
        for (const row of taskThreads) links.push({ taskId: task.id, threadId: row.threadId, attachedAt: Date.parse(row.attachedAt) });
      } catch {
        complete = false;
      }
    }
    return {
      tasks: tasks.map(({ id, key, title, status, priority, parentTaskId, updatedAt }) => ({
        id, key, title, status, priority, parentTaskId, updatedAt: Date.parse(updatedAt),
      })),
      links,
      taskProjectName: linked.name,
      complete,
      error: null,
    };
  } catch (cause) {
    return { tasks: [], links: [], taskProjectName: null, complete: false, error: message(cause) };
  }
}

export function taskActivityEvents(tasks: readonly CostTask[], projectId: string): ActivityEvent[] {
  return tasks
    .filter((task) => Number.isFinite(task.updatedAt))
    .map((task) => ({
      id: task.id,
      projectId,
      metric: "tasks" as const,
      source: "task" as const,
      at: task.updatedAt,
      title: `${task.key} · ${task.title}`,
      detail: task.status,
      threadId: null,
      environmentId: null,
      commitHash: null,
    }));
}

const openSpecSourcesSchema = z.object({
  environments: z.array(z.object({ id: z.string(), projectId: z.string(), path: z.string(), hostId: z.string(), name: z.string() })),
  preferredEnvironmentId: z.string().nullable(),
  preferredStoreId: z.string().nullable(),
});
const openSpecChangesSchema = z.object({
  changes: z.array(z.object({
    id: z.string(),
    title: z.string(),
    archived: z.boolean(),
    done: z.number(),
    total: z.number(),
    error: z.string().nullable(),
    updatedAt: z.number(),
    bslFlow: z.object({ complexity: z.enum(["S", "M", "L"]).nullable(), spec: z.boolean(), review: z.string() }).optional(),
    threads: z.array(z.object({
      id: z.string(),
      status: z.string(),
      managedTaskId: z.string().nullable().optional(),
      managedTaskStatus: z.object({ stage: z.string().nullable(), status: z.string(), blockers: z.array(z.string()) }).nullable().optional(),
    })),
  })),
});

export interface OpenSpecSummary {
  environmentId: string;
  storeId: string | null;
  total: number;
  active: number;
  blockedReviews: number;
  blockers: string[];
  stages: string[];
  done: number;
  totalTasks: number;
  updatedAt: number | null;
}

export function summarizeOpenSpec(payload: z.infer<typeof openSpecChangesSchema>, environmentId: string, storeId: string | null): OpenSpecSummary {
  const changes = payload.changes.filter((change) => !change.archived);
  const blockerSet = new Set<string>();
  const stageSet = new Set<string>();
  let blockedReviews = 0;
  for (const change of changes) {
    if (change.bslFlow?.review === "blocked") blockedReviews += 1;
    for (const thread of change.threads) {
      if (thread.managedTaskStatus?.stage) stageSet.add(thread.managedTaskStatus.stage);
      for (const blocker of thread.managedTaskStatus?.blockers ?? []) blockerSet.add(blocker);
    }
  }
  const active = changes.filter((change) => change.total > change.done).length;
  return {
    environmentId,
    storeId,
    total: changes.length,
    active,
    blockedReviews,
    blockers: [...blockerSet].slice(0, 20),
    stages: [...stageSet].slice(0, 20),
    done: changes.reduce((sum, change) => sum + change.done, 0),
    totalTasks: changes.reduce((sum, change) => sum + change.total, 0),
    updatedAt: changes.length > 0 ? Math.max(...changes.map((change) => change.updatedAt)) : null,
  };
}

export async function readProjectOpenSpec(sdk: Sdk, projectId: string, signal: AbortSignal, environmentId?: string): Promise<ReadResult<OpenSpecSummary | null>> {
  try {
    const sources = openSpecSourcesSchema.parse(await sdk.plugins.callRpc({
      pluginId: "openspec-bsl-flow",
      method: "sources",
      input: { projectId, ...(environmentId ? { environmentId } : {}) },
      outputSchema: openSpecSourcesSchema,
      signal,
    }));
    const selected = environmentId ?? sources.preferredEnvironmentId
      ?? sources.environments.find((environment) => environment.projectId === projectId)?.id
      ?? null;
    if (!selected) return { value: null, complete: true, error: null };
    const payload = openSpecChangesSchema.parse(await sdk.plugins.callRpc({
      pluginId: "openspec-bsl-flow",
      method: "changes",
      input: { environmentId: selected, storeId: sources.preferredStoreId },
      outputSchema: openSpecChangesSchema,
      signal,
    }));
    return { value: summarizeOpenSpec(payload, selected, sources.preferredStoreId), complete: true, error: null };
  } catch (cause) {
    return { value: null, complete: false, error: message(cause) };
  }
}

const operationCountsSchema = z.object({ tests: z.number(), failures: z.number(), errors: z.number(), skipped: z.number() });const operationSchema = z.object({
  id: z.string(), action: z.string(), profile: z.string(), kind: z.string(),
  state: z.enum(["running", "launched", "done", "failed", "cancelled", "interrupted"]),
  startedAt: z.string(), finishedAt: z.string().nullable(),
  revision: z.string().nullable(), dirty: z.boolean().nullable(), needsInspection: z.boolean(),
  counts: operationCountsSchema.nullable(),
  reports: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const platformDashboardSchema = z.object({ version: z.literal(1), entries: z.array(operationSchema) });

export async function readProjectOperations(
  sdk: Sdk,
  projectId: string,
  signal: AbortSignal,
  environmentId?: string,
): Promise<ReadResult<OperationEntry[]>> {
  try {
    const payload = platformDashboardSchema.parse(await sdk.plugins.callRpc({
      pluginId: "1c-properties",
      method: "platformDashboardV1",
      input: { projectId, ...(environmentId ? { environmentId } : {}) },
      outputSchema: platformDashboardSchema,
      signal,
    }));
    return { value: payload.entries.slice(0, OPERATION_LIMIT), complete: payload.entries.length <= OPERATION_LIMIT, error: null };
  } catch (cause) {
    return { value: [], complete: false, error: message(cause) };
  }
}

export function operationActivityEvents(entries: readonly OperationEntry[], projectId: string): ActivityEvent[] {
  return entries.flatMap((entry): ActivityEvent[] => {
    if (entry.state !== "done" && entry.state !== "failed") return [];
    const isTest = entry.action === "yaxunit" || entry.action === "vanessa" || entry.action === "check-syntax";
    if (!isTest && !isBuildAction(entry.action)) return [];
    const metric = isTest ? "tests" : "builds";
    const at = Date.parse(entry.finishedAt ?? entry.startedAt);
    if (!Number.isFinite(at)) return [];
    return [{
      id: entry.id,
      projectId,
      metric,
      source: metric === "tests" ? "test" : "operation",
      at,
      title: entry.action,
      detail: [entry.profile, entry.state, entry.counts ? `${entry.counts.tests} тестов, ${entry.counts.failures} сбоев` : null].filter(Boolean).join(" · "),
      threadId: null,
      environmentId: null,
      commitHash: null,
    }];
  });
}

export async function readProjectPassport(
  sdk: Sdk,
  projectId: string,
  signal: AbortSignal,
  environmentId?: string,
): Promise<ReadResult<PassportSnapshot | null>> {
  try {
    const snapshot = await sdk.plugins.callRpc({
      pluginId: "1c-properties",
      method: "passport",
      input: { projectId, ...(environmentId ? { environmentId } : {}) },
      outputSchema: passportSchema,
      signal,
    });
    return { value: snapshot, complete: true, error: null };
  } catch (cause) {
    return { value: null, complete: false, error: message(cause) };
  }
}

const tokenEventSchema = z.object({
  seq: z.number(),
  createdAt: z.number(),
  type: z.literal("thread/tokenUsage/updated"),
  data: z.object({
    tokenUsage: z.object({
      last: z.object({ totalTokens: z.number() }).passthrough(),
      total: z.object({
        inputTokens: z.number(), outputTokens: z.number(), cachedInputTokens: z.number(), totalTokens: z.number(),
        cacheReadInputTokens: z.number().optional(), cacheWriteInputTokens: z.number().optional(), reasoningOutputTokens: z.number().optional(),
      }),
    }),
  }),
});
const contextEventSchema = z.object({
  seq: z.number(),
  createdAt: z.number(),
  type: z.literal("thread/contextWindowUsage/updated"),
  data: z.object({
    contextWindowUsage: z.object({
      estimated: z.boolean(),
      cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
    }),
  }),
});

/** Latest cumulative snapshot per thread plus the cost the provider reported on the same read. */
export async function readProjectUsage(
  sdk: Sdk,
  threads: readonly DashboardThread[],
  signal: AbortSignal,
): Promise<ReadResult<CostThread[]>> {
  const rows: CostThread[] = [];
  let complete = true;
  let next = 0;
  const selected = threads.slice(0, USAGE_THREAD_LIMIT);
  const worker = async () => {
    for (;;) {
      const thread = selected[next++];
      if (!thread || signal.aborted) return;
      const base: CostThread = {
        threadId: thread.id,
        title: thread.title || thread.titleFallback || `Тред ${thread.id.slice(0, 8)}`,
        parentThreadId: thread.parentThreadId,
        providerId: thread.providerId,
        modelId: null,
        usage: null,
        lastTurnTokens: null,
        cost: null,
        status: "unreported",
      };
      try {
        const [events, options] = await Promise.all([
          sdk.threads.events.list({
            threadId: thread.id,
            types: ["thread/tokenUsage/updated", "thread/contextWindowUsage/updated"],
            order: "desc",
            limit: "50",
            signal,
          }),
          sdk.threads.defaultExecutionOptions({ threadId: thread.id, signal }).catch(() => null),
        ]);
        const token = events.map((event) => tokenEventSchema.safeParse(event)).find((result) => result.success);
        const context = events.map((event) => contextEventSchema.safeParse(event)).find((result) => result.success);
        const total = token?.success ? token.data.data.tokenUsage.total : null;
        const lastTurn = token?.success ? token.data.data.tokenUsage.last.totalTokens : null;
        const contextData = context?.success ? context.data.data.contextWindowUsage : null;
        const usage = total && token?.success ? {
          inputTokens: total.inputTokens,
          outputTokens: total.outputTokens,
          cachedInputTokens: total.cachedInputTokens,
          totalTokens: total.totalTokens,
          at: token.data.createdAt,
        } : null;
        rows.push({
          ...base,
          modelId: options?.model ?? null,
          status: usage ? "reported" : "unreported",
          usage,
          lastTurnTokens: lastTurn,
          cost: contextData?.cost
            ? { amount: contextData.cost.amount, currency: contextData.cost.currency, estimated: contextData.estimated }
            : null,
        });
      } catch {
        if (signal.aborted) return;
        rows.push({ ...base, status: "error" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, worker));
  if (threads.length > USAGE_THREAD_LIMIT) complete = false;
  return { value: rows, complete, error: null };
}



