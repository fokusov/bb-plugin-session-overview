import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentTree, formatAgentStatus, formatTokenCount, parseOrchestrationMetadata, projectGraphRunAttempts, projectWorkflowAttempts, readAgentEvents, type AgentEvent } from "../lib/session-agents.ts";

const thread = (id: string, parentThreadId: string | null, updatedAt = 0) => ({
  id, parentThreadId, title: null, titleFallback: null, status: "active", providerId: "codex", environmentId: null, updatedAt,
});

test("builds a stable tree only from visible rows and sorts siblings by activity", () => {
  const tree = buildAgentTree("root", [thread("root", null), thread("old", "root", 1), thread("new", "root", 3), thread("nested", "new", 2)]);
  assert.deepEqual(tree?.children.map(({ id }) => id), ["new", "old"]);
  assert.equal(tree?.children[0].children[0].id, "nested");
  assert.equal(buildAgentTree("missing", [thread("root", null)]), null);
});

test("formats statuses and token counts without inventing unavailable values", () => {
  assert.equal(formatAgentStatus("active"), "Работает");
  assert.equal(formatAgentStatus("some-future-status"), "some-future-status");
  assert.equal(formatTokenCount(null), "Недоступно");
  assert.equal(formatTokenCount(12000), "12 000");
});

test("reads a native delegation without a worker thread or a context snapshot", async () => {
  const delegation: AgentEvent = {
    id: "delegation-1", seq: 21, createdAt: 100, threadId: "parent", scope: { kind: "thread" },
    type: "item/delegation/completed",
    data: {
      providerThreadId: "provider-session",
      item: { id: "native-1", childRef: "provider-child", type: "delegation", label: "Проверка", status: "completed", background: true },
    },
  };
  const rows = await readAgentEvents({
    list: async ({ threadId, types, limit }) => {
      assert.equal(threadId, "parent");
      assert.equal(limit, "100");
      assert.ok(types?.includes("item/delegation/completed"));
      return [delegation, {
        ...delegation,
        id: "context-1",
        threadId: "unrelated",
        type: "thread/contextWindowUsage/updated",
        data: { providerThreadId: "unrelated-session", contextWindowUsage: { estimated: false, modelContextWindow: 1000, usedTokens: 2 } },
      }];
    },
  }, "parent", new AbortController().signal);
  assert.deepEqual(rows, [delegation]);
});

test("propagates access denial instead of representing it as empty history", async () => {
  const denied = Object.assign(new Error("Forbidden"), { status: 403 });
  await assert.rejects(readAgentEvents({
    list: async () => { throw denied; },
  }, "parent", new AbortController().signal), (error) => error === denied);
});

test("accepts only valid orchestration metadata and preserves optional run and review links", () => {
  assert.deepEqual(parseOrchestrationMetadata({ role: "reviewer", taskId: "task-1", parentThreadId: "parent", runId: "run-1", reviewMode: "isolated-worktree" }), {
    role: "reviewer", taskId: "task-1", parentThreadId: "parent", runId: "run-1", reviewMode: "isolated-worktree",
  });
  assert.equal(parseOrchestrationMetadata({ role: "", taskId: "task-1", parentThreadId: "parent" }), undefined);
  assert.equal(parseOrchestrationMetadata({ role: "reviewer", taskId: "task-1", parentThreadId: "parent", runId: 7 }), undefined);
  assert.equal(parseOrchestrationMetadata(null), undefined);
});

test("projects Graph Studio node attempts with worker thread ids and aggregate visit counters", () => {
  const attempts = projectGraphRunAttempts([{
    id: "run-1", graphId: "review", threadId: "parent", status: "running", updatedAt: 20,
    visits: { review: 3 },
    nodeRuns: [
      { id: "node-run-1", nodeId: "review", attempt: 1, status: "failed", childThreadId: "worker-1", startedAt: 1, endedAt: 5, error: "x".repeat(500) },
      { id: "node-run-2", nodeId: "review", attempt: 2, status: "running", childThreadId: "worker-2", startedAt: 8, endedAt: null, error: null },
    ],
  }]);
  assert.deepEqual(attempts.map(({ attempt, nodeVisitCount, childThreadId }) => [attempt, nodeVisitCount, childThreadId]), [
    [1, 3, "worker-1"], [2, 3, "worker-2"],
  ]);
  assert.equal(attempts[0].error?.length, 300);
  assert.notEqual(attempts[0].key, attempts[1].key);
});

test("keeps repeated workflow attempts distinct and projects only bounded, safe fields", () => {
  const attempts = projectWorkflowAttempts([
    { eventId: "event-1", threadId: "parent-thread", taskId: "task-1", agents: [
      { index: 0, attempt: 1, label: "Сбор данных", state: "running", model: "m1", lastProgressAt: 90 },
      { index: 0, attempt: 2, label: "Сбор данных", state: "done", model: "m1", lastProgressAt: 200, startedAt: 150, queuedAt: 120, durationMs: 50, resultPreview: "готово" },
    ] },
    { eventId: "event-2", threadId: "parent-thread", taskId: "task-1", agents: [
      { index: 0, attempt: 1, label: "Сбор данных", state: "failed", model: "m1", lastProgressAt: 100, error: "timeout" },
      { index: 0, attempt: 2, label: "Сбор данных", state: "done", model: "m1", lastProgressAt: 200, startedAt: 150, queuedAt: 120, durationMs: 50, resultPreview: "готово" },
    ] },
  ]);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].key, attempts[1].key);
  assert.deepEqual(attempts.map(({ attempt, state }) => [attempt, state]), [[1, "failed"], [2, "done"]]);
  assert.equal(attempts[0].sourceEventId, "event-2");
  assert.equal(attempts[1].resultPreview, "готово");
  assert.equal("promptPreview" in attempts[0], false);
});
