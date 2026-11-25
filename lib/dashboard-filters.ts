/**
 * Dashboard filter persistence.
 *
 * The page keeps the chosen period, metric, project and day when the user
 * opens a thread from a card and comes back. The value is validated field by
 * field, so an older or corrupted entry falls back to the default view instead
 * of breaking the page.
 */

import { dashboardMetrics, type CalendarPeriod, type DashboardMetric } from "./dashboard-activity.ts";

export interface DashboardFilters {
  period: CalendarPeriod;
  metric: DashboardMetric;
  projectId: string | null;
  day: string | null;
}

export const defaultDashboardFilters: DashboardFilters = {
  period: "last12",
  metric: "threads",
  projectId: null,
  day: null,
};

export const dashboardFiltersStorageKey = "session-overview.dashboard.filters.v1";
export const dashboardPinnedStorageKey = "session-overview.dashboard.pinned.v1";

export function parseDashboardFilters(value: unknown): DashboardFilters {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const period = record.period === "last12" || (typeof record.period === "number" && Number.isInteger(record.period) && record.period >= 2000 && record.period <= 2100)
    ? record.period
    : defaultDashboardFilters.period;
  const metric = typeof record.metric === "string" && (dashboardMetrics as readonly string[]).includes(record.metric)
    ? record.metric as DashboardMetric
    : defaultDashboardFilters.metric;
  const projectId = typeof record.projectId === "string" && record.projectId.length > 0 ? record.projectId : null;
  const day = typeof record.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.day) ? record.day : null;
  return { period, metric, projectId, day };
}

export function serializeDashboardFilters(filters: DashboardFilters): string {
  return JSON.stringify(filters);
}

export function parsePinnedProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}
