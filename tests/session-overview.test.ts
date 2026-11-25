import assert from "node:assert/strict";
import test from "node:test";
import { readSessionOverview } from "../lib/session-overview.ts";

const signal = new AbortController().signal;

function fixture(environments: Record<string, string | null>, failingEnvironment?: string) {
  const gitReads: string[] = [];
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) =>
        ({ id: threadId, environmentId: environments[threadId], projectId: "project", parentThreadId: null }),
      list: async () => [],
      defaultExecutionOptions: async () => null,
      experimental_headState: async () => { throw new Error("forbidden"); },
      events: { list: async () => [] },
    },
    projects: { get: async () => ({ id: "project", name: "Проект" }) },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) =>
        ({ id: environmentId, hostId: "machine", isGitRepo: environmentId !== "checkout" }),
    },
    hosts: { get: async () => ({ id: "machine" }) },
    plugins: {
      callRpc: async ({ method, input }: { method: string; input: { environmentId: string } }) => {
        if (method === "workspaceStatus") {
          gitReads.push(input.environmentId);
          if (input.environmentId === failingEnvironment) throw new Error("unavailable");
          return {
            outcome: "available",
            workspace: {
              workingTree: { fileCount: 2, hasUncommittedChanges: true },
              branch: { currentBranch: input.environmentId },
            },
          };
        }
        if (method === "pullRequests") return {};
        throw new Error("unavailable");
      },
    },
  } as unknown as Parameters<typeof readSessionOverview>[0];
  return { sdk, gitReads };
}

test("снимки двух тредов читают Git и проект в своих окружениях", async () => {
  const { sdk, gitReads } = fixture({ first: "branch-a", second: "branch-b" });
  const [first, second] = await Promise.all([
    readSessionOverview(sdk, "first", "branch-a", signal),
    readSessionOverview(sdk, "second", "branch-b", signal),
  ]);
  assert.equal(first?.workspace?.git?.outcome, "available");
  assert.equal(second?.workspace?.git?.outcome, "available");
  assert.equal(first?.workspace?.git && "branch" in first.workspace.git && first.workspace.git.branch, "branch-a");
  assert.equal(second?.workspace?.git && "branch" in second.workspace.git && second.workspace.git.branch, "branch-b");
  assert.deepEqual(gitReads.sort(), ["branch-a", "branch-b"]);
  assert.equal(await readSessionOverview(sdk, "first", "branch-b", signal), null);
});

test("окружение без Git и отказ источников сохраняют остальные разделы", async () => {
  const { sdk, gitReads } = fixture({ first: "checkout", second: "branch" }, "branch");
  const [checkout, branch] = await Promise.all([
    readSessionOverview(sdk, "first", "checkout", signal),
    readSessionOverview(sdk, "second", "branch", signal),
  ]);
  assert.equal(checkout?.workspace?.git?.outcome, "not_applicable");
  assert.equal(branch?.workspace?.git, null);
  assert.equal(branch?.openSpec, null);
  assert.equal(branch?.tasks, null);
  assert.equal(branch?.project?.name, "Проект");
  assert.deepEqual(gitReads, ["branch"]);
});
