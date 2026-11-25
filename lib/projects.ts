export interface ProjectSource {
  id: string;
  path: string;
  hostId: string;
  isDefault: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  kind: "personal" | "standard";
  sources: ProjectSource[];
}

export interface ThreadActivityRow {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  parentThreadId: string | null;
  updatedAt: number;
}

export interface ProjectActivity {
  threads: number;
  activeThreads: number;
}

export interface ActivitySnapshot {
  projects: Record<string, ProjectActivity>;
  updatedThreadsByDay: Record<string, number>;
  threadsByDay: Record<string, ThreadActivityRow[]>;
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function summarizeThreadActivity(
  rows: readonly ThreadActivityRow[],
  now = Date.now(),
  days = 30,
): ActivitySnapshot {
  const projects: Record<string, ProjectActivity> = {};
  const updatedThreadsByDay: Record<string, number> = {};
  const threadsByDay: Record<string, ThreadActivityRow[]> = {};
  const firstDay = new Date(now);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - (days - 1));
  const firstTimestamp = firstDay.getTime();

  for (const row of rows) {
    const project = projects[row.projectId] ??= { threads: 0, activeThreads: 0 };
    project.threads += 1;
    if (row.status === "active") project.activeThreads += 1;
    if (row.updatedAt >= firstTimestamp && row.updatedAt <= now) {
      const day = localDay(row.updatedAt);
      updatedThreadsByDay[day] = (updatedThreadsByDay[day] ?? 0) + 1;
      (threadsByDay[day] ??= []).push(row);
    }
  }

  return { projects, updatedThreadsByDay, threadsByDay };
}

export function summarizeProjects(
  projects: readonly ProjectSummary[],
): ProjectSummary[] {
  return projects
    .map(({ id, name, kind, sources }) => ({ id, name, kind, sources }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
