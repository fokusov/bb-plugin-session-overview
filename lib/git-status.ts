import { z } from "zod";
import type { useSdk } from "@get-bb/plugin-sdk/app";

// The published bb--git.workspaceStatus RPC contract. Deliberately validate
// only the fields rendered by this plugin; changed file paths are not exposed.
export const workspaceStatusSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      workingTree: z.object({
        fileCount: z.number().int().nonnegative(),
        hasUncommittedChanges: z.boolean(),
        state: z.string(),
      }).passthrough(),
      branch: z.object({ currentBranch: z.string().nullable(), defaultBranch: z.string() }).passthrough(),
      checkout: z.object({ headSha: z.string().min(1).nullable().optional() }).optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({ outcome: z.literal("not_applicable"), reason: z.literal("non_git_environment"), message: z.string().min(1) }).passthrough(),
  z.object({
    outcome: z.literal("unavailable"),
    failure: z.object({
      code: z.enum(["path_not_found", "not_git_repo", "workspace_type_mismatch", "permission_denied", "unknown_environment", "unknown"]),
      workspacePath: z.string().min(1),
      message: z.string().min(1),
    }).strict(),
  }).passthrough(),
]);

export function summarizeWorkspaceStatus(result: z.infer<typeof workspaceStatusSchema>) {
  if (result.outcome !== "available") return { outcome: result.outcome as "not_applicable" | "unavailable", branch: null, changedFiles: null, dirty: null };
  return {
    outcome: "available" as const,
    branch: result.workspace.branch.currentBranch,
    changedFiles: result.workspace.workingTree.fileCount,
    dirty: result.workspace.workingTree.hasUncommittedChanges,
  };
}

const patchSchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });
const diffFilesSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(z.object({ path: z.string(), revision: z.string(), binary: z.boolean() })),
    initialPatches: z.array(patchSchema),
    truncated: z.boolean(),
  }),
  z.object({ outcome: z.enum(["not_applicable", "unavailable"]) }),
]);
const diffPatchesSchema = z.record(z.string(), z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), patch: patchSchema }),
  z.object({ outcome: z.enum(["not_applicable", "unavailable"]) }),
]));
const target = { type: "uncommitted" } as const;

export function readUncommittedFiles(sdk: ReturnType<typeof useSdk>, environmentId: string, signal: AbortSignal) {
  return sdk.plugins.callRpc({
    pluginId: "bb--git", method: "files",
    input: { environmentId, target, ignoreWhitespace: false },
    outputSchema: diffFilesSchema, signal,
  });
}

export async function readUncommittedPatch(
  sdk: ReturnType<typeof useSdk>, environmentId: string, path: string, revision: string, signal: AbortSignal,
) {
  // The published Git contract serializes the revision-bound patch key as a tuple.
  const key = JSON.stringify([environmentId, target, false, path, revision]);
  const result = await sdk.plugins.callRpc({
    pluginId: "bb--git", method: "patches", input: { keys: [key] }, outputSchema: diffPatchesSchema, signal,
  });
  const match = result[key];
  return match?.outcome === "available" && match.patch.path === path ? match.patch : null;
}
