/**
 * Calendar and feed model for the 1C developer dashboard.
 *
 * Every event is project-scoped and carries a source-stable id. Commits are
 * deduplicated by hash inside one project, so the same commit seen in two
 * worktrees is counted once. All day boundaries are local to the interface:
 * one time zone for the calendar, the feed and the day filter.
 */

export const activityMetricDefinitions = [
  { id: "threads", label: "Треды", description: "Видимые треды по дню последнего обновления" },
  { id: "commits", label: "Коммиты", description: "Коммиты из git-history по авторской дате" },
  { id: "tasks", label: "Задачи", description: "Задачи BB Tasks по дню последнего изменения" },
  { id: "builds", label: "Сборки", description: "Сборки и разборы из журнала операций 1С" },
  { id: "tests", label: "Тесты", description: "Проверки, YAxUnit и Vanessa из журнала операций 1С" },
] as const;

export type DashboardMetric = (typeof activityMetricDefinitions)[number]["id"];
export const dashboardMetrics: readonly DashboardMetric[] = activityMetricDefinitions.map((item) => item.id);

/** Metrics without a public per-day contract. The UI shows the reason instead of zeros. */
export const unavailableActivityMetrics: Readonly<Record<string, string>> = {
  turns: "Ходы агента: BB не отдаёт историю ходов за период без чтения событий каждого треда, поэтому календарь их не показывает.",
  reviews: "Ревью: у BSL Flow есть текущее состояние ревью, но нет отметки времени события ревью.",
  tokens: "Токены: провайдер отдаёт только последний накопительный снимок треда, без разбивки по дням.",
};

export type ActivitySource = "thread" | "commit" | "task" | "operation" | "test";

export interface ActivityEvent {
  /** Stable identity of the source record, used to merge pages and deduplicate. */
  id: string;
  projectId: string;
  metric: DashboardMetric;
  source: ActivitySource;
  at: number;
  title: string;
  detail: string | null;
  threadId: string | null;
  environmentId: string | null;
  commitHash: string | null;
}

export type CalendarPeriod = "last12" | number;

export interface CalendarDay {
  day: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityCalendar {
  /** Weekly columns, Sunday first; null is a padding cell outside the range. */
  cells: (CalendarDay | null)[][];
  fromDay: string;
  toDay: string;
  total: number;
  max: number;
  /** Distinct projects with at least one event in range. */
  projects: number;
}

export interface FeedEvent extends ActivityEvent {
  projectName: string;
}

export interface FeedGroup {
  projectId: string;
  projectName: string;
  events: FeedEvent[];
}

export interface FeedMonth {
  month: string;
  label: string;
  total: number;
  projects: FeedGroup[];
}

export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function formatDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(day: string, amount: number): string {
  const date = dayDate(day);
  date.setDate(date.getDate() + amount);
  return formatDay(date);
}

function startOfWeek(day: string): string {
  const date = dayDate(day);
  date.setDate(date.getDate() - date.getDay());
  return formatDay(date);
}

function endOfWeek(day: string): string {
  const date = dayDate(day);
  date.setDate(date.getDate() + (6 - date.getDay()));
  return formatDay(date);
}

function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function calendarRange(period: CalendarPeriod, now = Date.now()): { fromDay: string; toDay: string } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const toDay = formatDay(today);
  if (period === "last12") {
    const from = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    return { fromDay: formatDay(from), toDay };
  }
  const end = new Date(period, 11, 31);
  const from = new Date(period, 0, 1);
  return { fromDay: formatDay(from), toDay: formatDay(end < today ? end : today) };
}

/** One timeline for the calendar and the feed: the same filter selects both. */
export function selectActivity(events: readonly ActivityEvent[], filter: { metric: DashboardMetric; projectId?: string | null }): ActivityEvent[] {
  return events.filter((event) => event.metric === filter.metric && (filter.projectId == null || event.projectId === filter.projectId));
}

export function dedupeCommits(events: readonly ActivityEvent[]): { events: ActivityEvent[]; removed: number } {
  const seen = new Set<string>();
  const kept: ActivityEvent[] = [];
  let removed = 0;
  for (const event of events) {
    if (event.source !== "commit" || !event.commitHash) {
      kept.push(event);
      continue;
    }
    const key = `${event.projectId}\u0000${event.commitHash}`;
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    kept.push(event);
  }
  return { events: kept, removed };
}

/** Merge a later source page without changing already rendered events. */
export function mergeActivityEvents(current: readonly ActivityEvent[], incoming: readonly ActivityEvent[]): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const event of [...current, ...incoming]) byId.set(`${event.source}\u0000${event.id}`, event);
  return [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

function levelOf(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function buildCalendar(
  events: readonly ActivityEvent[],
  filter: { metric: DashboardMetric; projectId?: string | null; period: CalendarPeriod },
  now = Date.now(),
): ActivityCalendar {
  const { fromDay, toDay } = calendarRange(filter.period, now);
  const counts = new Map<string, number>();
  const projects = new Set<string>();
  let total = 0;
  for (const event of selectActivity(events, filter)) {
    const day = localDay(event.at);
    if (day < fromDay || day > toDay) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
    projects.add(event.projectId);
    total += 1;
  }
  const max = Math.max(0, ...counts.values());
  const first = startOfWeek(fromDay);
  const last = endOfWeek(toDay);
  const cells: (CalendarDay | null)[][] = [];
  let column: (CalendarDay | null)[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const inRange = day >= fromDay && day <= toDay;
    const count = counts.get(day) ?? 0;
    column.push(inRange ? { day, count, level: levelOf(count, max) } : null);
    if (column.length === 7) {
      cells.push(column);
      column = [];
    }
  }
  return { cells, fromDay, toDay, total, max, projects: projects.size };
}

function monthLabel(month: string): string {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    .toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
}

export function buildFeed(
  events: readonly ActivityEvent[],
  filter: { metric: DashboardMetric; projectId?: string | null; day?: string | null },
  projectNames: Readonly<Record<string, string>>,
): FeedMonth[] {
  const selected = selectActivity(events, filter)
    .filter((event) => !filter.day || localDay(event.at) === filter.day)
    .slice()
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const months = new Map<string, Map<string, FeedEvent[]>>();
  for (const event of selected) {
    const month = monthKey(localDay(event.at));
    const projects = months.get(month) ?? new Map<string, FeedEvent[]>();
    const rows = projects.get(event.projectId) ?? [];
    rows.push({ ...event, projectName: projectNames[event.projectId] ?? event.projectId });
    projects.set(event.projectId, rows);
    months.set(month, projects);
  }
  return [...months.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, projects]) => {
      const groups = [...projects.entries()]
        .map(([projectId, rows]): FeedGroup => ({ projectId, projectName: rows[0]?.projectName ?? projectId, events: rows }))
        .sort((a, b) => b.events[0].at - a.events[0].at || a.projectName.localeCompare(b.projectName));
      return { month, label: monthLabel(month), total: groups.reduce((sum, group) => sum + group.events.length, 0), projects: groups };
    });
}

