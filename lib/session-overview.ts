import type { useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { summarizeWorkspaceStatus, workspaceStatusSchema } from "./git-status.ts";

type Sdk = ReturnType<typeof useSdk>;

async function read<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch {
    return null;
  }
}

const pullRequestSchema = z.record(z.string(), z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    pullRequest: z.object({
      number: z.number(),
      title: z.string(),
      url: z.url({ protocol: /^https?$/ }),
      updatedAt: z.iso.datetime(),
      checks: z.object({
        state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
        totalCount: z.number(),
        passedCount: z.number(),
        failedCount: z.number(),
        pendingCount: z.number(),
      }),
    }),
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable") }),
]));

const openSpecSourcesSchema = z.object({
  preferredEnvironmentId: z.string().nullable(),
  preferredChangeId: z.string().nullable(),
  preferredStoreId: z.string().nullable(),
});
const openSpecChangesSchema = z.object({
  changes: z.array(z.object({
    id: z.string(),
    title: z.string(),
    done: z.number(),
    total: z.number(),
    error: z.string().nullable(),
    bslFlow: z.object({
      complexity: z.enum(["S", "M", "L"]).nullable(),
      spec: z.boolean(),
      review: z.enum(["unknown", "optional", "required", "awaiting-validation", "blocked", "stale", "passed", "limited"]),
    }).optional(),
  })),
});
const openSpecDetailSchema = z.object({
  threads: z.array(z.object({
    id: z.string(),
    managedTaskId: z.string().nullable().optional(),
    managedTaskStatus: z.object({
      stage: z.string().nullable(),
      status: z.string(),
      blockers: z.array(z.string()),
    }).nullable().optional(),
  })),
});

const taskCardsSchema = z.object({
  cards: z.array(z.object({
    taskId: z.string(),
    activeThreads: z.array(z.object({ threadId: z.string() })),
  })),
});
const taskSchema = z.object({
  task: z.object({ key: z.string(), title: z.string(), status: z.string() }).nullable(),
});

async function readTasks(sdk: Sdk, threadId: string, signal: AbortSignal) {
  const { cards } = await sdk.plugins.callRpc({
    pluginId: "tasks",
    method: "listTaskCardMeta",
    input: {},
    outputSchema: taskCardsSchema,
    signal,
  });
  const linked = cards.filter(({ activeThreads }) => activeThreads.some((thread) => thread.threadId === threadId));
  return Promise.all(linked.map(({ taskId }) => sdk.plugins.callRpc({
    pluginId: "tasks",
    method: "getTask",
    input: { taskId },
    outputSchema: taskSchema,
    signal,
  }).then(({ task }) => task)));
}

async function readOpenSpec(sdk: Sdk, threadId: string, environmentId: string, signal: AbortSignal) {
  const sources = await sdk.plugins.callRpc({
    pluginId: "openspec-bsl-flow",
    method: "sources",
    input: { threadId },
    outputSchema: openSpecSourcesSchema,
    signal,
  });
  const changeId = sources.preferredChangeId;
  if (sources.preferredEnvironmentId !== environmentId) return { kind: "unavailable" as const };
  if (!changeId) return { kind: "unlinked" as const };
  const source = { environmentId, storeId: sources.preferredStoreId };
  const [catalog, detail] = await Promise.all([
    read(sdk.plugins.callRpc({ pluginId: "openspec-bsl-flow", method: "changes", input: source, outputSchema: openSpecChangesSchema, signal })),
    read(sdk.plugins.callRpc({ pluginId: "openspec-bsl-flow", method: "detail", input: { ...source, changeId }, outputSchema: openSpecDetailSchema, signal })),
  ]);
  return {
    kind: "linked" as const,
    changeId,
    storeId: sources.preferredStoreId,
    change: catalog?.changes.find((row) => row.id === changeId) ?? null,
    binding: detail?.threads.find(({ id }) => id === threadId) ?? null,
  };
}

async function readWorkspace(sdk: Sdk, environmentId: string, signal: AbortSignal) {
  const environment = await read(sdk.environments.get({ environmentId, signal }));
  if (!environment) return null;
  const host = read(sdk.hosts.get({ hostId: environment.hostId, signal }));
  if (!environment.isGitRepo) {
    return { environment, host: await host, git: { outcome: "not_applicable" as const }, pullRequest: null };
  }
  const [git, pullRequests, machine] = await Promise.all([
    read(sdk.plugins.callRpc({
      pluginId: "bb--git",
      method: "workspaceStatus",
      input: { environmentId },
      outputSchema: workspaceStatusSchema,
      signal,
    })),
    read(sdk.plugins.callRpc({
      pluginId: "bb--github-pr-status",
      method: "pullRequests",
      input: { keys: [environmentId] },
      outputSchema: pullRequestSchema,
      signal,
    })),
    host,
  ]);
  return {
    environment,
    host: machine,
    git: git ? summarizeWorkspaceStatus(git) : null,
    pullRequest: pullRequests?.[environmentId] ?? null,
  };
}

export async function readSessionOverview(sdk: Sdk, threadId: string, environmentId: string | null, signal: AbortSignal) {
  const thread = await sdk.threads.get({ threadId, signal });
  if (thread.id !== threadId || thread.environmentId !== environmentId) return null;
  const [project, workspace, parent, children, options, head, turn, usage, contextEvent, openSpec, tasks] = await Promise.all([
    read(sdk.projects.get({ projectId: thread.projectId, signal })),
    environmentId ? readWorkspace(sdk, environmentId, signal) : null,
    thread.parentThreadId ? read(sdk.threads.get({ threadId: thread.parentThreadId, signal })) : null,
    read(sdk.threads.list({ parentThreadId: threadId, includeHidden: false, archived: false, limit: 21, signal })),
    read(sdk.threads.defaultExecutionOptions({ threadId, signal })),
    read(sdk.threads.experimental_headState({ threadId, signal })),
    read(sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["turn/started", "turn/completed"], signal })),
    read(sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["thread/tokenUsage/updated", "thread/context/cleared"], signal })),
    read(sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["thread/contextWindowUsage/updated", "thread/context/cleared"], signal })),
    environmentId ? read(readOpenSpec(sdk, threadId, environmentId, signal)) : null,
    read(readTasks(sdk, threadId, signal)),
  ]);
  const contextRow = contextEvent?.[0];
  const usageRow = usage?.[0];
  const window = contextRow?.type === "thread/context/cleared" ? null : head?.contextWindowUsage ?? null;
  return {
    thread, project, workspace, parent, children, openSpec, tasks,
    model: options?.model ?? window?.snapshot?.model ?? null,
    window,
    windowTime: window?.snapshot?.capturedAt ?? (contextRow?.type === "thread/contextWindowUsage/updated" ? contextRow.createdAt : null),
    turn: turn?.[0] ?? null,
    usage: usageRow?.type === "thread/tokenUsage/updated" ? usageRow : null,
  };
}

export type SessionOverview = NonNullable<Awaited<ReturnType<typeof readSessionOverview>>>;
