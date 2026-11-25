import assert from "node:assert/strict";
import test from "node:test";
import { isQuotaStale, readMcpInventory, readProviderQuotas, readThreadTelemetry, remainingBudgetUsd, remainingQuota } from "../lib/session-telemetry.ts";

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

test("запрашивает квоту на совпадающей машине и отклоняет сменившийся аккаунт", async () => {
  const requests: string[] = [];
  const source = { pluginId: "test-provider", displayName: "Provider" };
  const sdk = {
    plugins: {
      experimental_discoverRpc: async () => [source],
      callRpc: async ({ input, method }: { method: string; input: { resourceId: string; refresh: boolean } }) => {
        if (method.endsWith("listResources")) return { resources: [
          { id: "first", accountKey: "a", providerId: "codex", scope: { kind: "host", hostId: "local" } },
          { id: "second", accountKey: "a", providerId: "codex", scope: { kind: "host", hostId: "elsewhere" } },
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

test("читает бюджеты других провайдеров на этой машине и общие бюджеты, не подставляя валюту в квоты", async () => {
  const requested: string[] = [];
  const resource = (id: string, providerId: string, scope: object) => ({ id, providerId, scope, label: id, accountKey: id });
  const sdk = {
    plugins: {
      experimental_discoverRpc: async () => [{ pluginId: "usage", displayName: "Usage" }],
      callRpc: async ({ input, method, outputSchema }: {
        input: { resourceId: string; refresh: boolean };
        method: string;
        outputSchema: { parse(value: unknown): unknown };
      }) => {
        if (method.endsWith("listResources")) return outputSchema.parse({ resources: [
          resource("extra", "acp-cursor", { kind: "host", hostId: "local" }),
          resource("remote", "acp-cursor", { kind: "host", hostId: "other" }),
          resource("pool", "codex", { kind: "shared" }),
          resource("current", "codex", { kind: "host", hostId: "local" }),
        ] });
        assert.equal(input.refresh, true);
        requested.push(input.resourceId);
        return outputSchema.parse({
          accountKey: input.resourceId, observedAt: 100,
          usage: { status: "ok", windows: [{
            id: "window", label: "Окно", model: null, usedPercent: 25, resetsAt: null,
            cost: input.resourceId === "extra" ? { limitUsdCents: 2500, usedUsdCents: 925 } : null,
          }] },
        });
      },
    },
  } as unknown as Parameters<typeof readProviderQuotas>[0];
  const rows = await readProviderQuotas(sdk, "codex", "local", signal, true);
  assert.deepEqual(requested.sort(), ["current", "extra", "pool"]);
  assert.deepEqual(rows.map(({ providerId, shared }) => [providerId, shared]), [
    ["codex", true], ["codex", false], ["acp-cursor", false],
  ]);
  const quota = rows[0].measurement?.usage;
  const budget = rows[2].measurement?.usage;
  assert.equal(quota?.status === "ok" && quota.windows[0].cost, null);
  assert.deepEqual(budget?.status === "ok" && budget.windows[0].cost, { limitUsdCents: 2500, usedUsdCents: 925 });
  assert.equal(remainingBudgetUsd({ limitUsdCents: 2500, usedUsdCents: 925 }), 15.75);
  assert.equal(remainingBudgetUsd({ limitUsdCents: 2500, usedUsdCents: 2510 }), 0);
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
