import assert from "node:assert/strict";
import test from "node:test";
import { isQuotaStale, readMcpInventory, readProviderQuotas, readThreadTelemetry, remainingQuota } from "../lib/session-telemetry.ts";

const signal = new AbortController().signal;

test("отбрасывает телеметрию другого провайдера и стоимость до очистки контекста", async () => {
  const sdk = {
    threads: { events: { list: async ({ types }: { types: string[] }) => {
      if (types.includes("thread/contextWindowUsage/updated")) return [{ threadId: "t1", type: "thread/context/cleared" }];
      if (types.includes("provider/rateLimits/updated")) return [{
        threadId: "t1", type: "provider/rateLimits/updated", data: { rateLimits: { providerId: "codex" } },
      }];
      return [];
    } } },
  } as unknown as Parameters<typeof readThreadTelemetry>[0];
  const metrics = await readThreadTelemetry(sdk, "t1", "opencode2", signal);
  assert.deepEqual(metrics, { cost: null, limits: null, tools: [] });
});

test("показывает последнее подтверждённое событие MCP только из выбранного треда", async () => {
  const sdk = {
    threads: { events: { list: async ({ types }: { types: string[] }) => {
      if (!types.includes("item/completed")) return [];
      const item = { type: "toolCall", server: "catalog", tool: "list", status: "completed" };
      return [
        { threadId: "other", type: "item/completed", createdAt: 120, data: { item: { ...item, server: "other" } } },
        { threadId: "t1", type: "item/completed", createdAt: 110, data: { item } },
        { threadId: "t1", type: "item/started", createdAt: 100, data: { item: { ...item, status: "pending" } } },
        { threadId: "t1", type: "item/started", createdAt: 95, data: { item: { type: "toolCall", tool: "shell", status: "pending" } } },
      ];
    } } },
  } as unknown as Parameters<typeof readThreadTelemetry>[0];
  assert.deepEqual((await readThreadTelemetry(sdk, "t1", "codex", signal)).tools, [
    { server: "catalog", tool: "list", status: "completed", at: 110 },
  ]);
});

test("запрашивает только квоту провайдера на совпадающей машине и отклоняет сменившийся аккаунт", async () => {
  const requests: string[] = [];
  const source = { pluginId: "test-provider", displayName: "Provider" };
  const sdk = {
    plugins: {
      experimental_discoverRpc: async () => [source],
      callRpc: async ({ input, method }: { method: string; input: { resourceId: string; refresh: boolean } }) => {
        if (method.endsWith("listResources")) return { resources: [
          { id: "first", accountKey: "a", providerId: "codex", scope: { kind: "host", hostId: "local" } },
          { id: "second", accountKey: "a", providerId: "codex", scope: { kind: "host", hostId: "elsewhere" } },
          { id: "third", accountKey: "a", providerId: "opencode2", scope: { kind: "host", hostId: "local" } },
          { id: "shared", accountKey: "a", providerId: "codex", scope: { kind: "shared" } },
        ] };
        assert.equal(input.refresh, false);
        requests.push(input.resourceId);
        return { accountKey: "b", observedAt: 1, usage: { status: "ok", windows: [] } };
      },
    },
  } as unknown as Parameters<typeof readProviderQuotas>[0];
  const quotas = await readProviderQuotas(sdk, "codex", "local", signal);
  assert.deepEqual(requests, ["first"]);
  assert.equal(quotas[0]?.measurement, null);
});

test("отмечает просроченное окно, старый замер и превышенную квоту", () => {
  assert.equal(isQuotaStale(null, 500, 1000), false);
  assert.equal(isQuotaStale(1, 1200, 1000), false);
  assert.equal(isQuotaStale(1, 1000, 1000), true);
  assert.equal(isQuotaStale(1, null, 900_001), true);
  assert.equal(remainingQuota(32.5), 67.5);
  assert.equal(remainingQuota(104), 0);
});

test("показывает отключённый MCP только в конфигурации нужной машины и провайдера", async () => {
  let hostId = "first";
  let inventoryReads = 0;
  const sdk = {
    plugins: {
      getSettings: async () => ({ values: { hostId } }),
      callRpc: async () => {
        inventoryReads++;
        return { scannedAt: "2026-11-25T12:00:00Z", truncated: false, servers: [
          { name: "disabled", harness: "Codex", scope: "user", state: "disabled" },
          { name: "workspace", harness: "Codex", scope: "project", project: "worktree-a", state: "configured" },
          { name: "different provider", harness: "OpenCode", scope: "user", state: "configured" },
          { name: "different workspace", harness: "Codex", scope: "project", project: "worktree-b", state: "configured" },
        ] };
      },
    },
  } as unknown as Parameters<typeof readMcpInventory>[0];
  const inventory = await readMcpInventory(sdk, "codex", "first", "worktree-a", signal);
  assert.deepEqual(inventory?.servers.map(({ name, state }) => [name, state]), [["disabled", "disabled"], ["workspace", "configured"]]);
  hostId = "other";
  assert.equal(await readMcpInventory(sdk, "codex", "first", "worktree-a", signal), null);
  assert.equal(inventoryReads, 1);
});
