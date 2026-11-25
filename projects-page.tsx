import { useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { summarizeWorkspaceStatus, workspaceStatusSchema } from "./lib/git-status.js";
import { summarizeProjects, type ProjectSummary } from "./lib/projects.js";
import { formatBytes } from "./lib/passport.js";
import type { PassportSnapshot } from "./lib/passport.js";
import { buildCalendar, buildFeed, calendarRange, dedupeCommits, localDay, unavailableActivityMetrics, activityMetricDefinitions, type ActivityEvent, type DashboardMetric } from "./lib/dashboard-activity.js";
import {
  defaultDashboardFilters,
  dashboardFiltersStorageKey,
  dashboardPinnedStorageKey,
  parseDashboardFilters,
  parsePinnedProjects,
  serializeDashboardFilters,
  type DashboardFilters,
} from "./lib/dashboard-filters.js";
import {
  formatTokens,
  summarizeTaskCost,
  type CostSummary,
  type CostThread,
} from "./lib/dashboard-cost.js";
import {
  relativeTime,
  selectProjectCards,
  summarizeSourceCounters,
  togglePinned,
  type ProjectCard,
  type ProjectSort,
} from "./lib/dashboard-projects.js";
import { buildProjectThreadForest, flattenThreadForest, threadTitle, type ProjectThreadRow } from "./lib/dashboard-threads.js";
import {
  operationActionLabels,
  operationStateLabels,
  summarizeQuality,
  type OperationEntry,
  type QualitySummary,
} from "./lib/dashboard-quality.js";
import {
  readDashboardThreads,
  readProjectCommits,
  readProjectOpenSpec,
  readProjectOperations,
  readProjectPassport,
  readProjectRevision,
  readProjectTasks,
  readProjectUsage,
  taskActivityEvents,
  operationActivityEvents,
  threadActivityEvents,
  THREAD_SCAN_LIMIT,
  type OpenSpecSummary,
  type ProjectTasks,
  type ReadResult,
} from "./lib/dashboard-data.js";
import type { DashboardThread, GitEnvironment } from "./lib/dashboard-types.js";
import "./dashboard.css";

type Sdk = ReturnType<typeof useSdk>;
type EnvironmentRow = Awaited<ReturnType<Sdk["environments"]["list"]>>[number];

type Loadable<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: T };

const FEED_PAGE_MONTHS = 3;
const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function readStoredFilters(): DashboardFilters {
  try {
    const raw = window.localStorage.getItem(dashboardFiltersStorageKey);
    return raw ? parseDashboardFilters(JSON.parse(raw)) : defaultDashboardFilters;
  } catch {
    return defaultDashboardFilters;
  }
}

function readStoredPins(): string[] {
  try {
    const raw = window.localStorage.getItem(dashboardPinnedStorageKey);
    return raw ? parsePinnedProjects(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A blocked storage must not break the dashboard.
  }
}

// The panel unmounts when a thread opens. Keep the last choice in the module so
// returning to the page restores it even when Web Storage is unavailable.
let sessionFilters: DashboardFilters | null = null;
let sessionPins: string[] | null = null;

function initialFilters(): DashboardFilters {
  return sessionFilters ?? readStoredFilters();
}

function initialPins(): string[] {
  return sessionPins ?? readStoredPins();
}

async function readGitEnvironments(sdk: Sdk, projectId: string, environments: readonly EnvironmentRow[], signal: AbortSignal): Promise<GitEnvironment[]> {
  const active = environments.filter((item) => item.status === "ready" && item.lifecycle.phase === "active" && item.hostLifecycle === "active" && item.isGitRepo);
  return Promise.all(active.map(async (environment): Promise<GitEnvironment> => {
    const base = {
      projectId,
      id: environment.id,
      name: environment.name,
      isWorktree: environment.isWorktree,
      branchName: environment.branchName,
    };
    try {
      const result = await sdk.plugins.callRpc({
        pluginId: "bb--git",
        method: "workspaceStatus",
        input: { environmentId: environment.id },
        outputSchema: workspaceStatusSchema,
        signal,
      });
      const summary = summarizeWorkspaceStatus(result);
      if (summary.outcome === "available") return {
        ...base,
        outcome: "available",
        branch: summary.branch,
        changedFiles: summary.changedFiles,
        hasUncommittedChanges: summary.dirty,
      };
      return { ...base, outcome: summary.outcome, branch: null, changedFiles: null, hasUncommittedChanges: null };
    } catch {
      return { ...base, outcome: "error", branch: null, changedFiles: null, hasUncommittedChanges: null };
    }
  }));
}

function passportKey(projectId: string, environmentId: string | null): string {
  return `${projectId}\u0000${environmentId ?? ""}`;
}

export function ProjectsPage(_props: PluginNavPanelProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ReadResult<DashboardThread[]>>({ value: [], complete: false, error: null });
  const [environments, setEnvironments] = useState<Record<string, EnvironmentRow[]>>({});
  const [gitEnvironments, setGitEnvironments] = useState<Record<string, GitEnvironment[]>>({});
  const [gitErrors, setGitErrors] = useState<Record<string, string>>({});
  const [selectedEnvironment, setSelectedEnvironment] = useState<Record<string, string | null>>({});
  const [passports, setPassports] = useState<Record<string, Loadable<PassportSnapshot | null>>>({});
  const [tasks, setTasks] = useState<Record<string, ProjectTasks>>({});
  const [openSpec, setOpenSpec] = useState<Record<string, ReadResult<OpenSpecSummary | null>>>({});
  const [operations, setOperations] = useState<Record<string, ReadResult<OperationEntry[]>>>({});
  const [revisions, setRevisions] = useState<Record<string, string | null>>({});
  const [usage, setUsage] = useState<Record<string, Loadable<CostSummary>>>({});
  const [filters, setFilters] = useState<DashboardFilters>(initialFilters);
  const [pinned, setPinned] = useState<string[]>(initialPins);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<ProjectSort>("activity");
  const [query, setQuery] = useState("");
  const [feedMonths, setFeedMonths] = useState(FEED_PAGE_MONTHS);
  const [commits, setCommits] = useState<{ status: "idle" | "loading" | "ready" | "error"; events: ActivityEvent[]; error: string | null; complete: boolean }>({ status: "idle", events: [], error: null, complete: false });
  const [refreshKey, setRefreshKey] = useState(0);
  const usageAborts = useRef(new Map<string, AbortController>());
  const passportAborts = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const controller = new AbortController();
    setProjectsError(null);
    void sdk.projects.list({ includePersonal: true, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setProjects(summarizeProjects(result));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setProjectsError(errorText(cause));
      });
    void readDashboardThreads(sdk, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setThreads(result); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setThreads({ value: [], complete: false, error: errorText(cause) });
      });
    return () => controller.abort();
  }, [sdk, refreshKey]);

  useEffect(() => () => {
    for (const controller of usageAborts.current.values()) controller.abort();
    for (const controller of passportAborts.current.values()) controller.abort();
  }, []);

  useEffect(() => {
    if (!projects || threads.value.length === 0) return;
    const controller = new AbortController();
    for (const project of projects) {
      const rows = threads.value.filter((thread) => thread.projectId === project.id);
      if (rows.length === 0) continue;
      void readProjectRevision(sdk, rows, controller.signal)
        .then((revision) => {
          if (!controller.signal.aborted) setRevisions((current) => ({ ...current, [project.id]: revision }));
        });
    }
    return () => controller.abort();
  }, [projects, threads, sdk]);

  // Per-project sources. Each read is independent: one failing source keeps the card usable.
  useEffect(() => {
    const controller = new AbortController();
    for (const project of projects ?? []) {
      void (async () => {
        let list: EnvironmentRow[] = [];
        try {
          list = await sdk.environments.list({ projectId: project.id, limit: 100, signal: controller.signal });
          if (controller.signal.aborted) return;
          setEnvironments((current) => ({ ...current, [project.id]: list }));
        } catch (cause) {
          if (!controller.signal.aborted) setGitErrors((current) => ({ ...current, [project.id]: errorText(cause) }));
        }
        const selected = selectedEnvironment[project.id] ?? null;
        void readProjectPassport(sdk, project.id, controller.signal, selected ?? undefined)
          .then((result) => {
            if (controller.signal.aborted) return;
            const key = passportKey(project.id, selected);
            setPassports((current) => ({
              ...current,
              [key]: result.error ? { status: "error", error: result.error } : { status: "ready", value: result.value },
            }));
          });
        void readProjectTasks(sdk, project.id, controller.signal)
          .then((value) => { if (!controller.signal.aborted) setTasks((current) => ({ ...current, [project.id]: value })); });
        void readProjectOpenSpec(sdk, project.id, controller.signal, selected ?? undefined)
          .then((value) => { if (!controller.signal.aborted) setOpenSpec((current) => ({ ...current, [project.id]: value })); });
        void readProjectOperations(sdk, project.id, controller.signal, selected ?? undefined)
          .then((value) => { if (!controller.signal.aborted) setOperations((current) => ({ ...current, [project.id]: value })); });
        if (list.length > 0) {
          void readGitEnvironments(sdk, project.id, list, controller.signal)
            .then((rows) => { if (!controller.signal.aborted) setGitEnvironments((current) => ({ ...current, [project.id]: rows })); })
            .catch((cause: unknown) => { if (!controller.signal.aborted) setGitErrors((current) => ({ ...current, [project.id]: errorText(cause) })); });
        }
      })();
    }
    return () => controller.abort();
    // selectedEnvironment intentionally only seeds the first read; changing a worktree reloads the passport below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, sdk, refreshKey]);

  useEffect(() => { sessionFilters = filters; store(dashboardFiltersStorageKey, filters); }, [filters]);
  useEffect(() => { sessionPins = pinned; store(dashboardPinnedStorageKey, pinned); }, [pinned]);

  const projectThreads = useMemo(() => {
    const byProject = new Map<string, DashboardThread[]>();
    for (const thread of threads.value) {
      const rows = byProject.get(thread.projectId) ?? [];
      rows.push(thread);
      byProject.set(thread.projectId, rows);
    }
    return byProject;
  }, [threads]);

  const projectNames = useMemo(() => Object.fromEntries((projects ?? []).map(({ id, name }) => [id, name])), [projects]);

  const taskLabelByThread = useMemo(() => {
    const labels = new Map<string, string>();
    for (const projectTasks of Object.values(tasks)) {
      const keys = new Map(projectTasks.tasks.map((task) => [task.id, task.key]));
      for (const link of projectTasks.links) {
        const key = keys.get(link.taskId);
        if (key && !labels.has(link.threadId)) labels.set(link.threadId, key);
      }
    }
    return labels;
  }, [tasks]);

  const cards = useMemo<ProjectCard[]>(() => (projects ?? []).map((project) => {
    const rows = projectThreads.get(project.id) ?? [];
    const lastActivityAt = rows.reduce<number | null>((latest, thread) => latest === null || thread.updatedAt > latest ? thread.updatedAt : latest, null);
    const openspec: OpenSpecSummary | null = openSpec[project.id]?.value ?? null;
    const blockers = openspec === null ? null : openspec.blockedReviews + openspec.blockers.length;
    const summary = usage[project.id]?.status === "ready" ? usage[project.id] : null;
    return {
      id: project.id,
      name: project.name,
      kind: project.kind,
      pinned: pinned.includes(project.id),
      lastActivityAt,
      activeThreads: rows.filter(({ status, displayStatus }) => status === "active" || displayStatus === "active" || displayStatus === "starting").length,
      blockers,
      tokens: summary && summary.status === "ready" ? summary.value.totals.totalTokens : null,
    };
  }), [projects, projectThreads, openSpec, pinned, usage]);

  const visibleCards = useMemo(() => selectProjectCards(cards, { query, showAll, sort }), [cards, query, showAll, sort]);

  const activityEvents = useMemo(() => {
    const list: ActivityEvent[] = [...threadActivityEvents(threads.value)];
    for (const [projectId, projectTasks] of Object.entries(tasks)) list.push(...taskActivityEvents(projectTasks.tasks, projectId));
    for (const [projectId, result] of Object.entries(operations)) list.push(...operationActivityEvents(result.value, projectId));
    if (commits.status === "ready") list.push(...commits.events);
    return dedupeCommits(list).events.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }, [threads, tasks, operations, commits]);

  const calendar = useMemo(() => buildCalendar(activityEvents, filters), [activityEvents, filters]);
  const periodEvents = useMemo(() => {
    const { fromDay, toDay } = calendarRange(filters.period);
    return activityEvents.filter((event) => {
      const day = localDay(event.at);
      return day >= fromDay && day <= toDay;
    });
  }, [activityEvents, filters.period]);
  const feed = useMemo(() => buildFeed(periodEvents, filters, projectNames), [periodEvents, filters, projectNames]);
  const shownFeed = feed.slice(0, feedMonths);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const currentYear = new Date().getFullYear();
  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    for (const event of activityEvents) years.add(new Date(event.at).getFullYear());
    for (let year = currentYear; year >= currentYear - 5; year -= 1) years.add(year);
    return [...years].sort((a, b) => b - a);
  }, [activityEvents, currentYear]);

  const commitThreads = useMemo(() => {
    if (!filters.projectId) return [];
    return threads.value.filter((thread) => thread.projectId === filters.projectId);
  }, [threads, filters.projectId]);

  useEffect(() => {
    if (filters.metric !== "commits" || !filters.projectId) {
      setCommits({ status: "idle", events: [], error: null, complete: false });
      return;
    }
    if (commitThreads.length === 0) {
      setCommits({ status: "idle", events: [], error: null, complete: false });
      return;
    }
    const controller = new AbortController();
    setCommits({ status: "loading", events: [], error: null, complete: false });
    const { fromDay } = calendarRange(filters.period);
    void readProjectCommits(sdk, commitThreads, fromDay, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCommits({ status: result.error && result.value.length === 0 ? "error" : "ready", events: result.value, error: result.error, complete: result.complete });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setCommits({ status: "error", events: [], error: errorText(cause), complete: false });
      });
    return () => controller.abort();
  }, [filters.metric, filters.period, filters.projectId, sdk, commitThreads]);

  const selectEnvironment = (projectId: string, environmentId: string | null) => {
    setSelectedEnvironment((current) => ({ ...current, [projectId]: environmentId }));
    const key = passportKey(projectId, environmentId);
    setPassports((current) => ({ ...current, [key]: { status: "loading" } }));
    passportAborts.current.get(projectId)?.abort();
    const controller = new AbortController();
    passportAborts.current.set(projectId, controller);
    void readProjectPassport(sdk, projectId, controller.signal, environmentId ?? undefined)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPassports((current) => ({
          ...current,
          [key]: result.error ? { status: "error", error: result.error } : { status: "ready", value: result.value },
        }));
      });
    void readProjectOperations(sdk, projectId, controller.signal, environmentId ?? undefined)
      .then((result) => { if (!controller.signal.aborted) setOperations((current) => ({ ...current, [projectId]: result })); });
    void readProjectOpenSpec(sdk, projectId, controller.signal, environmentId ?? undefined)
      .then((result) => { if (!controller.signal.aborted) setOpenSpec((current) => ({ ...current, [projectId]: result })); });
  };

  const loadUsage = (projectId: string) => {
    usageAborts.current.get(projectId)?.abort();
    const controller = new AbortController();
    usageAborts.current.set(projectId, controller);
    setUsage((current) => ({ ...current, [projectId]: { status: "loading" } }));
    const projectRows = projectThreads.get(projectId) ?? [];
    void readProjectUsage(sdk, projectRows, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const projectTasks = tasks[projectId];
        if (!projectTasks) {
          setUsage((current) => ({ ...current, [projectId]: { status: "error", error: "Задачи BB Tasks не загружены: атрибуция недоступна" } }));
          return;
        }
        setUsage((current) => ({
          ...current,
          [projectId]: { status: "ready", value: summarizeTaskCost(projectTasks.tasks, projectTasks.links, result.value) },
        }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setUsage((current) => ({ ...current, [projectId]: { status: "error", error: errorText(cause) } }));
      });
  };

  const updateFilter = (patch: Partial<DashboardFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const selectedDay = filters.day;
  const calendarProject = filters.projectId ? projectNames[filters.projectId] ?? filters.projectId : "Все проекты";
  const coverage = `${calendar.fromDay} — ${calendar.toDay}`;
  const metricLabel = activityMetricDefinitions.find(({ id }) => id === filters.metric)?.label ?? filters.metric;

  return <main className="dashboard-page">
    <header className="dashboard-header">
      <div>
        <h1>Проекты 1С</h1>
        <p>Активность, треды, расход и качество по зарегистрированным проектам BB.</p>
      </div>
      <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Обновить</button>
    </header>

    <section className="dashboard-panel" aria-label="Активность по дням">
      <div className="dashboard-panel-head">
        <h2>Активность</h2>
        <span className="dashboard-note">{calendarProject} · {metricLabel} · {coverage} · часовой пояс {timeZone}</span>
      </div>
      <div className="dashboard-toolbar">
        <label>Период
          <select
            value={String(filters.period)}
            onChange={(event) => updateFilter({ period: event.target.value === "last12" ? "last12" : Number(event.target.value), day: null })}
          >
            <option value="last12">Последние 12 месяцев</option>
            {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </label>
        <label>Метрика
          <select value={filters.metric} onChange={(event) => updateFilter({ metric: event.target.value as DashboardMetric, day: null })}>
            {activityMetricDefinitions.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label>Проект
          <select value={filters.projectId ?? ""} onChange={(event) => updateFilter({ projectId: event.target.value || null, day: null })}>
            <option value="">Все проекты</option>
            {(projects ?? []).map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {selectedDay && <button type="button" onClick={() => updateFilter({ day: null })}>Сбросить день: {selectedDay}</button>}
      </div>
      <div className="dashboard-calendar" role="grid" aria-label={`Календарь активности: ${metricLabel}, ${coverage}`}>
        <div className="dashboard-calendar-labels" aria-hidden="true">
          {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="dashboard-calendar-scroll">
          <div className="dashboard-calendar-weeks">
            {calendar.cells.map((week, index) => <div className="dashboard-calendar-week" role="row" key={index}>
              {week.map((cell, cellIndex) => cell === null
                ? <span className="dashboard-day dashboard-day-empty" key={cellIndex} aria-hidden="true" />
                : <button
                  key={cell.day}
                  type="button"
                  role="gridcell"
                  className={`dashboard-day dashboard-level-${cell.level}`}
                  aria-pressed={selectedDay === cell.day}
                  aria-label={`${cell.day}: ${cell.count} событий (${metricLabel})`}
                  title={`${cell.day}: ${cell.count}`}
                  onClick={() => updateFilter({ day: selectedDay === cell.day ? null : cell.day })}
                />)}
            </div>)}
          </div>
        </div>
      </div>
      <div className="dashboard-legend">
        <span>Меньше</span>
        {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`dashboard-day dashboard-level-${level}`} aria-hidden="true" />)}
        <span>Больше</span>
        <span className="dashboard-note">Событий: {calendar.total} · проектов: {calendar.projects}</span>
      </div>
      <ul className="dashboard-coverage" aria-label="Охват источников">        <li>Треды: {threads.value.length} видимых · история {threads.complete ? "полная" : `ограничена первыми ${THREAD_SCAN_LIMIT.toLocaleString()}`}</li>
        <li>Коммиты: {!filters.projectId ? "выберите проект, чтобы загрузить коммиты" : commitThreads.length === 0 ? "у проекта нет видимых тредов и окружений" : commits.status === "ready" ? `${commits.events.length}${commits.complete ? "" : " · частично"}` : commits.status === "error" ? "недоступны" : filters.metric === "commits" ? "загружаются…" : "загружаются при выборе метрики"}</li>
        <li>Задачи BB Tasks: {Object.values(tasks).reduce((sum, projectTasks) => sum + projectTasks.tasks.length, 0)}</li>
        <li>Операции 1С: {Object.values(operations).reduce((sum, result) => sum + result.value.length, 0)}</li>
      </ul>
      {!threads.complete && threads.error === null && <p role="status">История тредов ограничена первыми {THREAD_SCAN_LIMIT.toLocaleString()}; календарь и лента неполные.</p>}
      {threads.error && <p role="status">История тредов недоступна: {threads.error}</p>}
      {filters.metric === "commits" && !filters.projectId && <p role="status">Выберите проект в фильтре, чтобы загрузить коммиты.</p>}
      {filters.metric === "commits" && commits.status === "loading" && <p role="status">Загружаю коммиты из git-history…</p>}
      {filters.metric === "commits" && commits.error && <p role="status">Коммиты: {commits.error}</p>}
      {filters.metric === "commits" && commits.status === "ready" && !commits.complete && <p role="status">Коммиты прочитаны не полностью: показан ограниченный диапазон истории.</p>}
      <p className="dashboard-note">{unavailableActivityMetrics.turns} {unavailableActivityMetrics.reviews} {unavailableActivityMetrics.tokens}</p>
    </section>

    <section className="dashboard-panel" aria-label="Хронология работы">
      <div className="dashboard-panel-head">
        <h2>Хронология</h2>
        <span className="dashboard-note">{shownFeed.reduce((sum, month) => sum + month.total, 0)} событий · {shownFeed.length} из {feed.length} месяцев</span>
      </div>
      {shownFeed.length === 0 && <p>За выбранный период событий нет.</p>}
      {shownFeed.map((month) => <section className="dashboard-month" key={month.month}>
        <h3>{month.label} <small>{month.total}</small></h3>
        {month.projects.map((group) => <section className="dashboard-feed-group" key={group.projectId}>
          <h4>{group.projectName}</h4>
          <ul>
            {group.events.map((event) => <li key={`${event.source}:${event.id}`}>
              <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
              {" · "}
              {event.threadId
                ? <button type="button" className="dashboard-link" onClick={() => { if (event.threadId) navigate.toThread(event.threadId); }}>{event.title}</button>
                : event.title}
              {event.detail ? <span className="dashboard-note"> · {event.detail}</span> : null}
            </li>)}
          </ul>
        </section>)}
      </section>)}
      {feed.length > shownFeed.length && <button type="button" onClick={() => setFeedMonths((value) => value + FEED_PAGE_MONTHS)}>Показать более ранние события</button>}
    </section>

    <section aria-label="Карточки проектов">
      <div className="dashboard-panel-head">
        <h2>Проекты</h2>
        <span className="dashboard-note">По умолчанию: закреплённые и активные за 30 дней</span>
      </div>
      <div className="dashboard-toolbar">
        <label>Поиск<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя проекта" /></label>
        <label>Сортировка
          <select value={sort} onChange={(event) => setSort(event.target.value as ProjectSort)}>
            <option value="activity">По активности</option>
            <option value="blockers">По блокерам</option>
            <option value="cost">По расходу</option>
            <option value="name">По имени</option>
          </select>
        </label>
        <label className="dashboard-check"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Все проекты</label>
      </div>
      {projectsError && <p role="alert">Не удалось загрузить проекты: {projectsError}</p>}
      {!projects && !projectsError && <p>Загружаю проекты…</p>}
      {projects?.length === 0 && <p>Зарегистрированных проектов пока нет.</p>}
      {projects && visibleCards.length === 0 && cards.length > 0 && <p>Нет проектов под текущий фильтр.</p>}
      <div className="dashboard-cards">
        {visibleCards.map((card) => {
          const project = projects!.find(({ id }) => id === card.id)!;
          const selectedEnv = selectedEnvironment[project.id] ?? null;
          const passportResult = passports[passportKey(project.id, selectedEnv)];
          const projectTasks = tasks[project.id];
          const openspec = openSpec[project.id];
          const operationResult = operations[project.id];
          const usageState = usage[project.id];
          const rows = projectThreads.get(project.id) ?? [];
          return <ProjectCardView
            key={project.id}
            project={project}
            card={card}
            selectedEnvironmentId={selectedEnv}
            environments={environments[project.id] ?? []}
            git={gitEnvironments[project.id] ?? []}
            gitError={gitErrors[project.id] ?? null}
            passport={passportResult}
            tasks={projectTasks}
            openSpec={openspec}
            operations={operationResult}
            revision={revisions[project.id] ?? null}
            usage={usageState}
            commitCount={commits.status === "ready" ? commits.events.filter((event) => event.projectId === project.id).length : null}
            threads={rows}
            taskLabelByThread={taskLabelByThread}
            onTogglePin={() => setPinned((current) => togglePinned(current, project.id))}
            onSelectEnvironment={(environmentId) => selectEnvironment(project.id, environmentId)}
            onLoadUsage={() => loadUsage(project.id)}
            onOpenProject={() => navigate.toProject(project.id)}
            onOpenThread={(threadId) => navigate.toThread(threadId)}
          />;
        })}
      </div>
    </section>
  </main>;
}

function ProjectCardView(props: {
  project: ProjectSummary;
  card: ProjectCard;
  selectedEnvironmentId: string | null;
  environments: readonly EnvironmentRow[];
  git: readonly GitEnvironment[];
  gitError: string | null;
  passport: Loadable<PassportSnapshot | null> | undefined;
  tasks: ProjectTasks | undefined;
  openSpec: ReadResult<OpenSpecSummary | null> | undefined;
  operations: ReadResult<OperationEntry[]> | undefined;
  revision: string | null;
  usage: Loadable<CostSummary> | undefined;
  commitCount: number | null;
  threads: readonly DashboardThread[];
  taskLabelByThread: ReadonlyMap<string, string>;
  onTogglePin(): void;
  onSelectEnvironment(environmentId: string | null): void;
  onLoadUsage(): void;
  onOpenProject(): void;
  onOpenThread(threadId: string): void;
}) {
  const { project, card, passport, tasks, openSpec, operations, usage, threads } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const openTasks = tasks ? tasks.tasks.filter(({ status }) => status !== "done" && status !== "canceled").length : null;
  const forest = useMemo(() => buildProjectThreadForest(threads.map((thread): ProjectThreadRow => ({
    id: thread.id,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    status: thread.status,
    displayStatus: thread.displayStatus,
    updatedAt: thread.updatedAt,
    environmentId: thread.environmentId,
    taskLabel: props.taskLabelByThread.get(thread.id) ?? null,
  }))), [threads, props.taskLabelByThread]);
  const flat = flattenThreadForest(forest);
  const quality = useMemo(() => operations ? summarizeQuality(operations.value, { freshAfterMs: DEFAULT_FRESHNESS_MS, sourceRevision: props.revision }) : null, [operations, props.revision]);

  return <article className="dashboard-card">
    <header className="dashboard-card-head">
      <button type="button" className="dashboard-pin" aria-pressed={card.pinned} title={card.pinned ? "Открепить" : "Закрепить"} onClick={props.onTogglePin}>{card.pinned ? "★" : "☆"}</button>
      <div>
        <h3>{project.name}</h3>
        <p className="dashboard-note">
          {project.kind === "personal" ? "Личный проект" : "Проект"} · {relativeTime(card.lastActivityAt)}
          {" · "}{threads.length} тредов{card.activeThreads > 0 ? ` · ${card.activeThreads} активных` : ""}
          {openTasks !== null ? ` · открытых задач: ${openTasks}` : ""}
          {props.commitCount !== null ? ` · коммитов за период: ${props.commitCount}` : ""}
          {card.blockers !== null ? ` · блокеров: ${card.blockers}` : ""}
        </p>
      </div>
      <div className="dashboard-card-actions">
        <button type="button" onClick={props.onOpenProject}>Открыть проект</button>
        <button type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}>{detailsOpen ? "Свернуть детали" : "Детали"}</button>
      </div>
    </header>

    {detailsOpen && <section className="dashboard-details" aria-label={`Детали проекта ${project.name}`}>
      <div className="dashboard-detail-grid">
        <section aria-label="Рабочие копии">
          <h4>Рабочие копии</h4>
          {props.environments.length === 0 && <p>Рабочие окружения не зарегистрированы.</p>}
          {props.environments.length > 0 && <label>Выбор worktree
            <select value={props.selectedEnvironmentId ?? ""} onChange={(event) => props.onSelectEnvironment(event.target.value || null)}>
              <option value="">Основной source</option>
              {props.environments.map((environment) => <option key={environment.id} value={environment.id}>
                {environment.name || environment.path || environment.id}{environment.isWorktree ? " · worktree" : ""}{environment.branchName ? ` · ${environment.branchName}` : ""}
              </option>)}
            </select>
          </label>}
          <ul>
            {project.sources.map((source) => <li key={source.id}>{source.path}{source.isDefault ? " · основной" : ""} · host {source.hostId}</li>)}
          </ul>
        </section>
        <section aria-label="Git">
          <h4>Git</h4>
          {props.gitError && <p role="status">Git недоступен: {props.gitError}</p>}
          {props.environments.length === 0 && <p>Рабочих окружений нет: Git-статус источника без окружения не читается.</p>}
          {props.environments.length > 0 && props.environments.every((environment) => !environment.isGitRepo) && <p>Git не настроен ни в одном окружении проекта.</p>}
          {props.environments.some((environment) => environment.isGitRepo) && props.git.length === 0 && !props.gitError && <p>Нет готовых Git-окружений.</p>}
          {props.git.length > 0 && <ul>{props.git.map((workspace) => <li key={workspace.id}>
            {workspace.name || workspace.branchName || workspace.id}{workspace.isWorktree ? " · worktree" : ""}:{" "}
            {workspace.outcome === "available"
              ? `${workspace.branch ?? "ветка не определена"} · изменённых файлов: ${workspace.changedFiles ?? "нет данных"}${workspace.hasUncommittedChanges ? " · есть незакоммиченные изменения" : ""}`
              : workspace.outcome === "not_applicable" ? "Git не настроен" : workspace.outcome === "error" ? "Git status недоступен (нужен плагин bb--git)" : "Git status недоступен"}
          </li>)}</ul>}
        </section>
        <section aria-label="Паспорт конфигурации">
          <h4>Конфигурация и исходники</h4>
          <PassportDetails state={passport} />
        </section>
        <section aria-label="OpenSpec и задачи">
          <h4>OpenSpec и BSL Flow</h4>
          {!openSpec && <p>Загружаю изменения OpenSpec…</p>}
          {openSpec?.error && <p role="status">OpenSpec недоступен: {openSpec.error}</p>}
          {openSpec && !openSpec.error && !openSpec.value && <p>Для проекта не найден предпочитаемый Environment OpenSpec.</p>}
          {openSpec?.value && <>
            <p>Изменений: {openSpec.value.total} · активных: {openSpec.value.active} · задач: {openSpec.value.done} из {openSpec.value.totalTasks}</p>
            <p>Ревью заблокировано: {openSpec.value.blockedReviews}</p>
            {openSpec.value.stages.length > 0 && <p>Стадии BSL Flow: {openSpec.value.stages.join(", ")}</p>}
            {openSpec.value.blockers.length > 0 && <ul aria-label="Блокеры BSL Flow">{openSpec.value.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            <UrlLink href="/plugins/openspec-bsl-flow/openspec">Открыть OpenSpec</UrlLink>
          </>}
          {tasks && <p>BB Tasks: {tasks.tasks.length} задач{tasks.complete ? "" : " · связь тредов загружена не полностью"}{tasks.error ? ` · ${tasks.error}` : ""}</p>}
          {tasks && tasks.tasks.length > 0 && <ul>{tasks.tasks.slice(0, 8).map((task) => <li key={task.id}>
            <UrlLink href={`/plugins/tasks/tasks/task/${encodeURIComponent(task.key)}`}>{task.key} · {task.title}</UrlLink> · {task.status}
          </li>)}</ul>}
          {tasks && tasks.tasks.length > 8 && <p className="dashboard-note">Показаны первые 8 задач; полный список — в BB Tasks.</p>}
          <UrlLink href="/plugins/tasks/tasks">Открыть BB Tasks</UrlLink>
        </section>
      </div>

      <QualityDetails quality={quality} operations={operations} />

      <section aria-label="Расход проекта">
        <div className="dashboard-panel-head">
          <h4>Расход</h4>
          <button type="button" onClick={props.onLoadUsage} disabled={usage?.status === "loading"}>
            {usage?.status === "loading" ? "Загружаю…" : usage?.status === "ready" ? "Обновить расход" : "Загрузить расход"}
          </button>
        </div>
        {!usage && <p>Токены читаются по явному запросу: один последний накопительный снимок на тред, дети и «Без задачи» входят в сумму.</p>}
        {usage?.status === "error" && <p role="status">Расход недоступен: {usage.error}</p>}
        {usage?.status === "ready" && <CostDetails summary={usage.value} />}
      </section>
    </section>}

    <section className="dashboard-thread-list" aria-label={`Треды проекта ${project.name}`}>
      <h4>Треды</h4>
      {flat.length === 0 && <p>Видимых тредов нет.</p>}
      {flat.length > 0 && <div className="dashboard-scroll" tabIndex={0} role="group" aria-label="Прокручиваемый список тредов">
        <ul>
          {flat.map(({ node, depth }) => <li key={node.id} style={{ paddingInlineStart: depth * 16 }}>
            <button type="button" onClick={() => props.onOpenThread(node.id)}>
              <span>{threadTitle(node)}</span>
              <small>{node.displayStatus ?? node.status}{node.taskLabel ? ` · ${node.taskLabel}` : ""} · {relativeTime(node.updatedAt)}</small>
            </button>
          </li>)}
        </ul>
      </div>}
    </section>
  </article>;
}

function PassportDetails({ state }: { state: Loadable<PassportSnapshot | null> | undefined }) {
  if (!state) return <p>Загружаю паспорт…</p>;
  if (state.status === "error") return <p role="status">Паспорт 1С недоступен: {state.error}</p>;
  if (state.status === "loading") return <p>Загружаю паспорт…</p>;
  const snapshot = state.value;
  if (!snapshot) return <p>Паспорт недоступен для выбранной рабочей копии.</p>;
  const counters = summarizeSourceCounters(snapshot.metrics);
  return <>
    {snapshot.ambiguous && <p role="status">Найден неоднозначный набор конфигураций.</p>}
    {!snapshot.configComplete && <p role="status">Метаданные конфигурации неполные{snapshot.configError ? `: ${snapshot.configError}` : ""}.</p>}
    {snapshot.configurations.length === 0
      ? <p>{snapshot.configComplete ? "Конфигурация не обнаружена." : "Нет данных о конфигурации."}</p>
      : <ul>{snapshot.configurations.map((configuration, index) => <li key={`${configuration.root}-${index}`}>
        <strong>{configuration.format.toUpperCase()}</strong>{configuration.name ? ` · ${configuration.name}` : " · имя: нет данных"}
        {configuration.synonym ? ` · ${configuration.synonym}` : ""}
        {configuration.version ? ` · ${configuration.version}` : " · версия: нет данных"}
        {snapshot.configurations.length > 1 ? ` · ${configuration.root}` : ""}
      </li>)}</ul>}
    {snapshot.configurations.length > 0 && <p className="dashboard-note">Расширения: контракт passport v1 не отдаёт состав расширений.</p>}
    <p>
      {counters.complete || counters.trackedFiles > 0 || counters.trackedBytes > 0
        ? <>Отслеживаемые файлы: {counters.trackedFiles.toLocaleString()} · {formatBytes(counters.trackedBytes)}{counters.complete ? "" : " · данные неполные"}</>
        : "Объём отслеживаемых файлов: нет данных"}
    </p>
    {counters.byExtension.length > 0 && <ul>{counters.byExtension.slice(0, 6).map(({ extension, bytes }) => <li key={extension}>{extension}: {formatBytes(bytes)}</li>)}</ul>}
    {counters.reason && <p className="dashboard-note">Причина неполного объёма: {counters.reason}</p>}
    <p className="dashboard-note">Строки BSL и объекты метаданных: контракт passport v1 не отдаёт эти счётчики. Снимок: {new Date(snapshot.snapshotAt).toLocaleString("ru-RU")}</p>
  </>;
}

function QualityDetails({ quality, operations }: { quality: QualitySummary | null; operations: ReadResult<OperationEntry[]> | undefined }) {
  if (!operations) return <section aria-label="Качество и операции"><h4>Качество и операции</h4><p>Загружаю журнал операций…</p></section>;
  if (operations.error) return <section aria-label="Качество и операции"><h4>Качество и операции</h4><p role="status">Журнал операций 1С недоступен: {operations.error}</p></section>;
  if (!quality || quality.entries.length === 0) return <section aria-label="Качество и операции"><h4>Качество и операции</h4><p>Журнал операций пуст.</p></section>;
  const test = quality.latestTest;
  const load = quality.latestLoad;
  return <section aria-label="Качество и операции">
    <h4>Качество и операции</h4>
    {test ? <div className="dashboard-quality">
      <p>
        {operationActionLabels[test.action] ?? test.action} · профиль {test.profile} · {operationStateLabels[test.state] ?? test.state}
        {test.counts ? ` · тестов ${test.counts.tests}, сбоев ${test.counts.failures}, ошибок ${test.counts.errors}, пропущено ${test.counts.skipped}` : ""}
      </p>
      <p className={quality.testFresh === false ? "dashboard-warning" : "dashboard-note"}>
        {quality.testFresh === true ? "Отчёт свежий" : quality.testFresh === false ? `Отчёт устарел: ${quality.testStaleReason}` : quality.testStaleReason ?? "Свежесть не определена"}
        {test.revision ? ` · ревизия ${test.revision}` : " · ревизия не записана"}
        {test.dirty ? " · были незакоммиченные изменения" : ""}
      </p>
      {quality.testDelta && <p>С прошлого сопоставимого прогона: тесты {signed(quality.testDelta.tests)}, сбои {signed(quality.testDelta.failures)}, ошибки {signed(quality.testDelta.errors)}, пропуски {signed(quality.testDelta.skipped)}.</p>}
      {quality.previousTest && <p className="dashboard-note">Предыдущий прогон: {new Date(quality.previousTest.finishedAt ?? quality.previousTest.startedAt).toLocaleString("ru-RU")}
        {quality.previousTest.counts ? ` · тестов ${quality.previousTest.counts.tests}, сбоев ${quality.previousTest.counts.failures}, ошибок ${quality.previousTest.counts.errors}, пропущено ${quality.previousTest.counts.skipped}` : ""}
        {quality.previousTest.revision ? ` · ревизия ${quality.previousTest.revision}` : ""}
      </p>}
      {test.reports.length > 0 && <ul>{test.reports.map((report) => <li key={`${report.id}-${report.name}`}>{report.name} · запуск {report.id.slice(0, 8)}</li>)}</ul>}
    </div> : <p>Результатов тестов и проверок нет.</p>}
    {!test && <p className="dashboard-note">Диагностика BSL LS и АПК: публичного контракта отчёта с ревизией пока нет.</p>}
    {quality.latestBuild && <p>Последняя сборка: {operationActionLabels[quality.latestBuild.action] ?? quality.latestBuild.action} · {operationStateLabels[quality.latestBuild.state] ?? quality.latestBuild.state} · {new Date(quality.latestBuild.finishedAt ?? quality.latestBuild.startedAt).toLocaleString("ru-RU")}</p>}
    {load && <p>
      Последняя загрузка: {operationActionLabels[load.action] ?? load.action} · профиль {load.profile} · {operationStateLabels[load.state] ?? load.state}
      {quality.confirmedLoadRevision ? ` · ревизия по журналу ${quality.confirmedLoadRevision}` : " · ревизия базы не подтверждена"}
      {load.needsInspection ? " · требуется проверка состояния базы" : ""}
    </p>}
    {quality.revisionMismatch && <p className="dashboard-warning" role="status">Исходники разошлись с базой: загружена ревизия {quality.revisionMismatch.loaded}, текущая {quality.revisionMismatch.source}.</p>}
    <UrlLink href="/plugins/1c-properties/projects">Открыть операции 1С</UrlLink>
  </section>;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function CostDetails({ summary }: { summary: CostSummary }) {
  return <>
    <p>Сумма учтённого расхода: {formatTokens(summary.totals.totalTokens)} токенов · покрытие: {summary.coverage.reported} из {summary.coverage.threads} тредов{summary.coverage.failed > 0 ? `, ошибок чтения: ${summary.coverage.failed}` : ""}.</p>
    <p className="dashboard-note">Вход {formatTokens(summary.totals.inputTokens)} · выход {formatTokens(summary.totals.outputTokens)} · из кэша {formatTokens(summary.totals.cachedInputTokens)}. Это сумма последних накопительных снимков провайдера: после сброса счётчика ранняя история может отсутствовать.</p>
    {summary.duplicateLinks > 0 && <p className="dashboard-note">Тред привязан к нескольким задачам: учтён один раз по раннему вложению, лишних связей: {summary.duplicateLinks}.</p>}
    {summary.orphanLinks > 0 && <p role="status">Связей с неизвестными задачами: {summary.orphanLinks}; расход оставлен в строке «Без задачи».</p>}
    {summary.byProviderModel.length > 0 && <ul>{summary.byProviderModel.map((row) => <li key={`${row.providerId}-${row.modelId}`}>
      {row.providerId ?? "провайдер неизвестен"} · {row.modelId ?? "модель неизвестна"}: {formatTokens(row.totalTokens)} токенов · {row.threads} тредов
    </li>)}</ul>}
    {summary.tasks.length > 0 && <ul className="dashboard-cost-tasks">{summary.tasks.map((row) => <CostTaskItem key={row.task.id} row={row} depth={0} />)}</ul>}
    <p>Без задачи: {formatTokens(summary.unassigned.total.totalTokens)} токенов · {summary.unassigned.threads.length} тредов</p>
    {summary.unassigned.threads.length > 0 && <ul className="dashboard-note">{summary.unassigned.threads.slice(0, 5).map((thread) => <li key={thread.threadId}>
      {thread.title}: {formatTokens(thread.usage?.totalTokens)} токенов{thread.lastTurnTokens !== null ? ` · последний ход ${formatTokens(thread.lastTurnTokens)}` : ""}{thread.cost ? ` · ${thread.cost.amount} ${thread.cost.currency}${thread.cost.estimated ? " (оценка)" : ""}` : ""}
    </li>)}</ul>}
    <p className="dashboard-note">Фактическая стоимость показывается только когда провайдер её передал; расчётных тарифов дашборд не подставляет.</p>
  </>;
}

function CostTaskItem({ row, depth }: { row: CostSummary["tasks"][number]; depth: number }) {
  const cost = row.threads.map((thread) => thread.cost).find((value) => value !== null) ?? null;
  return <li style={{ marginInlineStart: depth * 14 }}>
    <span>{row.task.key} · {row.task.title}</span>{" · "}<span>{row.task.status}</span>{" · "}<strong>{formatTokens(row.total.totalTokens)}</strong>
    {row.own.totalTokens !== row.total.totalTokens ? ` (свои ${formatTokens(row.own.totalTokens)})` : ""}
    {cost ? ` · ${cost.amount} ${cost.currency}${cost.estimated ? " · оценка" : " · фактические данные"}` : ""}
    {row.threads.length > 0 && <ul className="dashboard-note">{row.threads.slice(0, 5).map((thread) => <li key={thread.threadId}>
      {thread.title}: {formatTokens(thread.usage?.totalTokens)} токенов{thread.lastTurnTokens !== null ? ` · последний ход ${formatTokens(thread.lastTurnTokens)}` : ""}
    </li>)}</ul>}
    {row.children.length > 0 && <ul>{row.children.map((child) => <CostTaskItem key={child.task.id} row={child} depth={depth + 1} />)}</ul>}
  </li>;
}


