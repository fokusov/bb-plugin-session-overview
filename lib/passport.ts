import { z } from "zod";

export const passportSchema = z.object({
  // 1c-properties returns null for sourceId when an environmentId was passed.
  sourceId: z.string().nullable(),
  environmentId: z.string().nullable(),
  hostId: z.string(),
  snapshotAt: z.string(),
  configurations: z.array(z.object({
    root: z.string(),
    format: z.string(),
    name: z.string().nullable(),
    synonym: z.string().nullable(),
    version: z.string().nullable(),
  }).strict()),
  ambiguous: z.boolean(),
  configComplete: z.boolean(),
  configError: z.string().nullable(),
  metrics: z.object({
    complete: z.boolean(),
    trackedFiles: z.number().int(),
    trackedBytes: z.number().int(),
    byExtension: z.record(z.string(), z.number().int()),
    reason: z.string().nullable(),
  }).strict(),
}).strict();

export type PassportSnapshot = z.infer<typeof passportSchema>;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
