import type { useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

type Sdk = ReturnType<typeof useSdk>;
const listMethod = "provider-usage.v1.listResources";
const getMethod = "provider-usage.v1.getResource";

const resourceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  accountKey: z.string().nullable().default(null),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string() }),
  ]),
});
const inventorySchema = z.object({ resources: z.array(resourceSchema) });
const measurementSchema = z.object({
  accountKey: z.string().nullable().default(null),
  observedAt: z.number().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      windows: z.array(z.object({
        id: z.string(),
        label: z.string(),
        usedPercent: z.number().nonnegative(),
        resetsAt: z.iso.datetime({ offset: true }).nullable(),
        model: z.string().nullable(),
        cost: z.object({
          usedUsdCents: z.number().nonnegative(),
          limitUsdCents: z.number().positive(),
        }).nullable().optional(),
      })),
    }),
    z.object({ status: z.enum(["not_installed", "unauthenticated", "expired", "error"]) }),
  ]),
});
const mcpInventorySchema = z.object({
  scannedAt: z.iso.datetime(),
  truncated: z.boolean(),
  servers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    harness: z.string(),
    scope: z.enum(["user", "project"]),
    project: z.string().nullable(),
    state: z.enum(["configured", "disabled", "invalid"]),
  })),
});

const mcpHarnesses: Readonly<Record<string, string>> = { codex: "Codex", opencode2: "OpenCode" };

export async function readMcpInventory(
  sdk: Sdk, providerId: string, hostId: string | null, workspacePath: string | null, signal: AbortSignal,
) {
  const harness = mcpHarnesses[providerId];
  if (!harness || !hostId) return null;
  const getInventoryHost = async () => {
    const settings = await sdk.plugins.getSettings({ pluginId: "mcp-manager", signal });
    const configured = settings.values.hostId;
    return (typeof configured === "string" ? configured.trim() : "") || (await sdk.system.config({ signal })).primaryHostId;
  };
  if (await getInventoryHost() !== hostId) return null;
  const inventory = await sdk.plugins.callRpc({
    pluginId: "mcp-manager", method: "inventory", input: null, outputSchema: mcpInventorySchema, signal,
  });
  if (await getInventoryHost() !== hostId) return null;
  return {
    scannedAt: inventory.scannedAt,
    truncated: inventory.truncated,
    servers: inventory.servers.filter((server) => server.harness === harness &&
      (server.scope === "user" || (workspacePath !== null && server.project === workspacePath))),
  };
}

export function isQuotaStale(observedAt: number | null, resetsAt: number | null, now: number) {
  return observedAt !== null && (now - observedAt >= 15 * 60_000 || (resetsAt !== null && resetsAt <= now));
}

export function remainingQuota(usedPercent: number) {
  return Math.max(0, 100 - usedPercent);
}

export function remainingBudgetUsd(cost: { usedUsdCents: number; limitUsdCents: number }) {
  return Math.max(0, cost.limitUsdCents - cost.usedUsdCents) / 100;
}

export async function readProviderQuotas(
  sdk: Sdk, providerId: string, hostId: string | null, signal: AbortSignal, refresh = false,
) {
  const sources = await sdk.plugins.experimental_discoverRpc({ method: listMethod, signal });
  const results = await Promise.allSettled(sources.map(async (source) => {
    const { resources } = await sdk.plugins.callRpc({
      pluginId: source.pluginId, method: listMethod, input: {}, outputSchema: inventorySchema, signal,
    });
    const matches = resources.filter(({ scope }) => scope.kind === "shared" || scope.hostId === hostId);
    return Promise.all(matches.map(async (resource) => {
      const measurement = await sdk.plugins.callRpc({
        pluginId: source.pluginId, method: getMethod, input: { resourceId: resource.id, refresh }, outputSchema: measurementSchema, signal,
      }).catch(() => null);
      const sameAccount = measurement?.accountKey === resource.accountKey;
      return {
        id: `${source.pluginId}:${resource.id}`,
        label: resource.label,
        providerId: resource.providerId,
        shared: resource.scope.kind === "shared",
        source: source.displayName,
        measurement: sameAccount ? measurement : null,
      };
    }));
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => Number(b.providerId === providerId) - Number(a.providerId === providerId));
}

export async function readThreadTelemetry(sdk: Sdk, threadId: string, providerId: string, signal: AbortSignal) {
  const [context, limits, tools] = await Promise.all([
    sdk.threads.events.list({
      threadId, types: ["thread/contextWindowUsage/updated", "thread/context/cleared"], order: "desc", limit: "1", signal,
    }).catch(() => null),
    sdk.threads.events.list({
      threadId, types: ["provider/rateLimits/updated"], order: "desc", limit: "5", signal,
    }).catch(() => null),
    sdk.threads.events.list({
      threadId, types: ["item/started", "item/completed", "thread/context/cleared"], order: "desc", limit: "40", signal,
    }).catch(() => null),
  ]);
  const contextRow = context?.[0];
  const cost = contextRow?.threadId === threadId && contextRow.type === "thread/contextWindowUsage/updated"
    ? contextRow.data.contextWindowUsage.cost : null;
  const rates = limits?.find((row) => row.threadId === threadId && row.type === "provider/rateLimits/updated" && row.data.rateLimits.providerId === providerId);
  const observed = new Map<string, { server: string; tool: string; status: string; at: number }>();
  for (const event of tools ?? []) {
    if (event.threadId !== threadId) continue;
    if (event.type === "thread/context/cleared") break;
    if (event.type !== "item/started" && event.type !== "item/completed") continue;
    const { item } = event.data;
    if (item.type !== "toolCall" || !item.server) continue;
    const key = JSON.stringify([item.server, item.tool]);
    if (!observed.has(key)) observed.set(key, {
      server: item.server, tool: item.tool, status: item.status, at: event.createdAt,
    });
  }
  return {
    cost: cost && contextRow?.type === "thread/contextWindowUsage/updated"
      ? { ...cost, estimated: contextRow.data.contextWindowUsage.estimated, at: contextRow.createdAt }
      : null,
    limits: rates?.type === "provider/rateLimits/updated" ? { ...rates.data.rateLimits, at: rates.createdAt } : null,
    tools: tools ? Array.from(observed.values()) : null,
  };
}
