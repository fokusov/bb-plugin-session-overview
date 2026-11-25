import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProjects, summarizeThreadActivity } from "../lib/projects.ts";
import { summarizeWorkspaceStatus, workspaceStatusSchema } from "../lib/git-status.ts";
import { formatBytes, passportSchema } from "../lib/passport.ts";
import { latestTokenUsageTotal, summarizeProjectTokens } from "../lib/token-usage.ts";

test("sorts project cards by display name without changing source metadata", () => {
  const fixture = [
    { id: "p2", name: "Бухгалтерия", kind: "standard" as const, gitRemoteUrl: "https://user:secret@example.test/repo", sources: [] },
    { id: "p1", name: "Альфа", kind: "personal" as const, sources: [
      { id: "w1", path: "C:/work/alpha", hostId: "host-local", isDefault: true },
      { id: "w2", path: "D:/work/alpha", hostId: "host-remote", isDefault: false },
    ] },
  ];
  assert.deepEqual(summarizeProjects(fixture).map(({ id }) => id), ["p1", "p2"]);
  assert.equal(fixture[0].name, "Бухгалтерия");
  assert.equal(summarizeProjects(fixture)[0].sources.length, 2);
  assert.equal("gitRemoteUrl" in summarizeProjects(fixture)[1], false);
});

test("projects only a minimal summary from the published Git workspaceStatus response", () => {
  const response = workspaceStatusSchema.parse({
    outcome: "available",
    workspace: {
      workingTree: {
        insertions: 2,
        deletions: 1,
        lineStatsComplete: true,
        fileCount: 3,
        files: [{ path: "private/name.bsl", status: "M", insertions: 2, deletions: 1 }],
        hasUncommittedChanges: true,
        state: "dirty",
      },
      checkout: { state: "branch" },
      branch: { currentBranch: "feature/example", defaultBranch: "main" },
      mergeBase: null,
      allChanges: { insertions: 2, deletions: 1, lineStatsComplete: true, fileCount: 3 },
    },
  });
  assert.deepEqual(summarizeWorkspaceStatus(response), {
    outcome: "available",
    branch: "feature/example",
    changedFiles: 3,
    dirty: true,
  });
});

test("accepts the documented non-Git and unavailable outcomes", () => {
  assert.equal(workspaceStatusSchema.parse({ outcome: "not_applicable", reason: "non_git_environment", message: "Not a Git workspace" }).outcome, "not_applicable");
  assert.equal(workspaceStatusSchema.parse({
    outcome: "unavailable",
    failure: { code: "permission_denied", workspacePath: "C:/workspace", message: "Access denied" },
  }).outcome, "unavailable");
});

test("preserves partial passport status and never invents missing configuration values", () => {
  const passport = passportSchema.parse({
    sourceId: "source-primary",
    environmentId: null,
    hostId: "host-local",
    snapshotAt: "2026-11-25T10:00:00.000Z",
    configurations: [{ root: ".", format: "xml", name: "Demo", synonym: null, version: "1.0" }],
    ambiguous: false,
    configComplete: false,
    configError: "metadata unavailable",
    metrics: { complete: false, trackedFiles: 7, trackedBytes: 2048, byExtension: { ".bsl": 2048 }, reason: "tracked-file-size-limit" },
  });
  assert.equal(passport.configurations[0].synonym, null);
  assert.equal(passport.configComplete, false);
  assert.equal(passport.metrics.complete, false);
  assert.equal(formatBytes(passport.metrics.trackedBytes), "2.0 КБ");
});

test("keeps the newest cumulative token snapshot instead of adding older snapshots", () => {
  assert.equal(latestTokenUsageTotal([
    { sequence: 22, totalTokens: 1400 },
    { sequence: 10, totalTokens: 900 },
  ]), 1400);
  assert.equal(latestTokenUsageTotal([]), null);
});

test("token coverage separates reported, absent, and failed threads", () => {
  const summary = summarizeProjectTokens([
    { id: "t1", projectId: "p1", title: "Reported", titleFallback: null },
    { id: "t2", projectId: "p1", title: null, titleFallback: "No usage" },
    { id: "t3", projectId: "p1", title: "Unavailable", titleFallback: null },
  ], new Map([["t1", 1200]]), new Set(["t3"]), false);
  assert.equal(summary.totalTokens, 1200);
  assert.equal(summary.reportedThreads, 1);
  assert.equal(summary.unreportedThreads, 1);
  assert.equal(summary.failedThreads, 1);
  assert.equal(summary.historyComplete, false);
  assert.equal(summary.threads[1].totalTokens, null);
});

test("counts each visible thread once on its last-updated local day", () => {
  const now = new Date(2026, 4, 30, 12).getTime();
  const activity = summarizeThreadActivity([
    { id: "t1", projectId: "p1", title: "One", titleFallback: null, status: "active", parentThreadId: null, updatedAt: new Date(2026, 4, 30, 9).getTime() },
    { id: "t2", projectId: "p1", title: "Two", titleFallback: null, status: "idle", parentThreadId: "parent", updatedAt: new Date(2026, 4, 30, 10).getTime() },
    { id: "t3", projectId: "p2", title: null, titleFallback: "Three", status: "idle", parentThreadId: null, updatedAt: new Date(2026, 3, 1).getTime() },
  ], now);
  assert.deepEqual(activity.projects.p1, { threads: 2, activeThreads: 1 });
  assert.equal(activity.updatedThreadsByDay["2026-05-30"], 2);
  assert.deepEqual(activity.threadsByDay["2026-05-30"].map(({ id }) => id), ["t1", "t2"]);
  assert.equal(Object.keys(activity.updatedThreadsByDay).length, 1);
});
