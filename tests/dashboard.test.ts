import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCalendar,
  buildFeed,
  calendarRange,
  dedupeCommits,
  localDay,
  mergeActivityEvents,
  selectActivity,
  type ActivityEvent,
} from "../lib/dashboard-activity.ts";
import { parseDashboardFilters, parsePinnedProjects, serializeDashboardFilters } from "../lib/dashboard-filters.ts";
import { isDefaultVisible, selectProjectCards, summarizeSourceCounters, togglePinned, type ProjectCard } from "../lib/dashboard-projects.ts";
import { buildProjectThreadForest, flattenThreadForest, type ProjectThreadRow } from "../lib/dashboard-threads.ts";
import { summarizeTaskCost, type CostTask, type CostThread } from "../lib/dashboard-cost.ts";
import { operationSourceGit, reportFreshness, summarizeQuality, type OperationEntry } from "../lib/dashboard-quality.ts";
import { passportSchema } from "../lib/passport.ts";
import { operationActivityEvents, readProjectOperations, summarizeOpenSpec, taskActivityEvents } from "../lib/dashboard-data.ts";
import { summarizeThreadHistory } from "../lib/dashboard-usage.ts";
import type { AgentEvent } from "../lib/session-agents.ts";

const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

test("observed deltas reconcile after resets, independently of turn coverage", () => {
  const thread = { id: "t", projectId: "p", environmentId: "a", title: "Review", titleFallback: null, status: "idle",
    displayStatus: null, parentThreadId: "parent", updatedAt: at(2026, 11, 25), providerId: "codex" };
  const scope = (turnId?: string) => turnId ? { kind: "turn", turnId } : { kind: "thread" };
  const token = (seq: number, totalTokens: number, turnId?: string, session = "a") => ({
    seq, threadId: "t", createdAt: at(2026, 11, seq < 7 ? 24 : 25), scope: scope(turnId),
    type: "thread/tokenUsage/updated",
    data: { providerThreadId: session, tokenUsage: { total: { totalTokens } } },
  });
  const review = { seq: 5, threadId: "t", createdAt: at(2026, 11, 24), scope: scope("r1"), type: "turn/completed", data: { status: "completed" } };
  const rows = [
    token(1, 100, "prior"), token(3, 130, "r1"), token(3, 130, "r1"), token(4, 140),
    review, { ...review, seq: 6 }, token(7, 8, "r2"), token(8, 12, "r2"),
    token(11, 30, "r3", "b"), token(12, 40, "r3", "b"), { ...token(10, 10000), threadId: "other" },
  ].reverse() as unknown as AgentEvent[];
  const result = summarizeThreadHistory(rows, thread, true);
  assert.equal(result.latest, 40);
  assert.equal(result.undated, 30);
  assert.equal(result.resets, 2);
  assert.equal(result.unattributedTurnTokens, 10);
  assert.deepEqual(result.turns.map(({ tokens }) => tokens), [30, 4, 10]);
  assert.equal(result.events.filter(({ metric }) => metric === "reviews").length, 1);
  assert.equal(result.events.filter(({ metric }) => metric === "turns").length, 1);
  const calendar = buildCalendar(result.events, { metric: "tokens", projectId: "p", period: 2026 }, at(2026, 11, 26));
  assert.equal(calendar.total, 54);
  assert.deepEqual(calendar.cells.flat().filter((row) => row?.count).map((row) => row?.count), [40, 14]);
  const clear = { ...review, seq: 13, type: "thread/context/cleared" } as unknown as AgentEvent;
  assert.equal(summarizeThreadHistory([...rows, clear], thread, false).latest, null);
});

test("compares operation revisions against the selected checkout or an exact default source", () => {
  const sources = [{ id: "src", hostId: "local", path: "C:\\Repo\\", isDefault: true }];
  const main = { id: "root", hostId: "local", path: "c:/repo", headSha: "main" };
  const a = { id: "a", hostId: "local", path: "C:/repo-a", headSha: "rev-a" };
  const b = { id: "b", hostId: "local", path: "C:/repo-b", headSha: "rev-b" };
  const otherMachine = { ...main, id: "remote", hostId: "remote", headSha: "unrelated" };
  assert.equal(operationSourceGit([b, a, main], sources, "a"), a);
  assert.equal(operationSourceGit([main, a, b], sources, "b"), b);
  assert.equal(operationSourceGit([otherMachine, a, main], sources, null), main);
  assert.equal(operationSourceGit([otherMachine, a, b], sources, null), undefined);
  assert.equal(operationSourceGit([main, a], sources, "b"), undefined);
});

test("отчёт диагностики свежий только при совпавшей зафиксированной ревизии", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const report = { finishedAt: "2026-11-24T12:00:00.000Z", revision: "a" };
  assert.equal(reportFreshness(report, "a", now).fresh, true);
  assert.equal(reportFreshness(report, "b", now).fresh, false);
  assert.equal(reportFreshness(report, null, now).fresh, null);
  assert.equal(reportFreshness({ ...report, revision: null }, "a", now).fresh, null);
  assert.equal(reportFreshness(report, "a", now, undefined, true).fresh, null);
});

test("журнал v1 загружается только если метод v2 отсутствует", async () => {
  for (const code of ["unknown_method", "handler_error"]) {
    const methods: string[] = [];
    const scope = { projectId: "p", environmentId: "a" };
    const callRpc = async ({ method, input }: { method: string; input: unknown }) => {
      assert.deepEqual(input, scope);
      methods.push(method);
      if (method === "platformDashboardV2") throw Object.assign(new Error("v2 failure"), { code });
      return { version: 1, entries: [] };
    };
    const sdk = { plugins: { callRpc } } as unknown as Parameters<typeof readProjectOperations>[0];
    const result = await readProjectOperations(sdk, scope.projectId, new AbortController().signal, scope.environmentId);
    assert.deepEqual(result.value, { entries: [], diagnostics: null });
    if (code === "unknown_method") {
      assert.equal(result.error, null);
      assert.deepEqual(methods, ["platformDashboardV2", "platformDashboardV1"]);
    } else {
      assert.equal(result.error, "v2 failure");
      assert.deepEqual(methods, ["platformDashboardV2"]);
    }
  }
});

function event(overrides: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "at">): ActivityEvent {
  return {
    projectId: "p1",
    metric: "threads",
    source: "thread",
    title: overrides.id,
    detail: null,
    threadId: overrides.id,
    environmentId: null,
    commitHash: null,
    ...overrides,
  };
}

test("календарь использует локальный день, выбранный год и общий фильтр метрики и проекта", () => {
  assert.equal(localDay(at(2026, 1, 2)), "2026-01-02");
  const events = [
    event({ id: "a", at: at(2026, 1, 2) }),
    event({ id: "b", at: at(2026, 1, 2, 20) }),
    event({ id: "c", at: at(2026, 1, 3), projectId: "p2" }),
    event({ id: "d", at: at(2026, 1, 4), metric: "commits", source: "commit", commitHash: "h1" }),
    event({ id: "e", at: at(2025, 12, 31) }),
  ];
  const calendar = buildCalendar(events, { metric: "threads", period: 2026 }, at(2026, 11, 25));
  assert.equal(calendar.fromDay, "2026-01-01");
  assert.equal(calendar.toDay, "2026-11-25");
  assert.equal(calendar.total, 3);
  assert.equal(calendar.projects, 2);
  const days = calendar.cells.flat().filter((cell): cell is NonNullable<typeof cell> => cell !== null);
  assert.equal(days.find(({ day }) => day === "2026-01-02")?.count, 2);
  assert.equal(days.find(({ day }) => day === "2026-01-02")?.level, 4);
  assert.equal(days.find(({ day }) => day === "2026-01-03")?.count, 1);
  assert.equal(selectActivity(events, { metric: "threads", projectId: "p2" }).map(({ id }) => id).join(), "c");
});

test("последние 12 месяцев начинаются в первый день месяца 11 месяцев назад", () => {
  const range = calendarRange("last12", at(2026, 11, 25));
  assert.equal(range.fromDay, "2025-12-01");
  assert.equal(range.toDay, "2026-11-25");
});

test("коммит в двух worktree учитывается один раз на проект", () => {
  const events = [
    event({ id: "w1:h", at: at(2026, 5, 2), metric: "commits", source: "commit", projectId: "p1", commitHash: "h" }),
    event({ id: "w2:h", at: at(2026, 5, 2), metric: "commits", source: "commit", projectId: "p1", commitHash: "h" }),
    event({ id: "w2:h2", at: at(2026, 5, 3), metric: "commits", source: "commit", projectId: "p2", commitHash: "h" }),
  ];
  const result = dedupeCommits(events);
  assert.equal(result.events.length, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.events.map(({ id }) => id), ["w1:h", "w2:h2"]);
});

test("лента группирует месяцы и проекты и соблюдает дневной фильтр", () => {
  const events = [
    event({ id: "a", at: at(2026, 5, 2), projectId: "p1" }),
    event({ id: "b", at: at(2026, 5, 4), projectId: "p2" }),
    event({ id: "c", at: at(2026, 4, 30), projectId: "p1" }),
  ];
  const names = { p1: "Альфа", p2: "Бета" };
  const feed = buildFeed(events, { metric: "threads" }, names);
  assert.deepEqual(feed.map(({ month }) => month), ["2026-05", "2026-04"]);
  assert.deepEqual(feed[0].projects.map(({ projectName }) => projectName), ["Бета", "Альфа"]);
  const dayFeed = buildFeed(events, { metric: "threads", day: "2026-05-02" }, names);
  assert.equal(dayFeed.length, 1);
  assert.equal(dayFeed[0].total, 1);
  assert.equal(dayFeed[0].projects[0].events[0].projectName, "Альфа");
});

test("подгрузка страницы истории не дублирует события", () => {
  const merged = mergeActivityEvents(
    [event({ id: "a", at: at(2026, 5, 2) })],
    [event({ id: "a", at: at(2026, 5, 2) }), event({ id: "b", at: at(2026, 4, 1) })],
  );
  assert.deepEqual(merged.map(({ id }) => id), ["a", "b"]);
});

test("фильтры и закрепления переживают возврат и не ломаются от старых значений", () => {
  const filters = parseDashboardFilters({ period: 2025, metric: "commits", projectId: "p1", day: "2025-03-04" });
  assert.deepEqual(filters, { period: 2025, metric: "commits", projectId: "p1", day: "2025-03-04" });
  assert.deepEqual(parseDashboardFilters({ period: 1990, metric: "obsolete", projectId: 5, day: "вчера" }), {
    period: "last12", metric: "threads", projectId: null, day: null,
  });
  assert.deepEqual(parseDashboardFilters(serializeDashboardFilters(filters)), filters);
  assert.deepEqual(parsePinnedProjects(["p1", "p1", 2, ""]), ["p1"]);
  assert.deepEqual(togglePinned(["p1"], "p2"), ["p1", "p2"]);
  assert.deepEqual(togglePinned(["p1", "p2"], "p1"), ["p2"]);
});

test("карточки по умолчанию показывают активные за 30 дней и закреплённые, сортировка не выдумывает значения", () => {
  const now = at(2026, 11, 25);
  const cards: ProjectCard[] = [
    { id: "old", name: "Старый", kind: "standard", pinned: false, lastActivityAt: at(2026, 9, 1), activeThreads: 0, blockers: null, tokens: null },
    { id: "pinned", name: "Закреплённый", kind: "standard", pinned: true, lastActivityAt: at(2026, 1, 1), activeThreads: 0, blockers: 0, tokens: 10 },
    { id: "active", name: "Активный", kind: "standard", pinned: false, lastActivityAt: at(2026, 11, 20), activeThreads: 1, blockers: 2, tokens: 100 },
  ];
  assert.equal(isDefaultVisible(cards[0], now), false);
  assert.deepEqual(
    selectProjectCards(cards, { query: "", showAll: false, sort: "activity", now }).map(({ id }) => id),
    ["active", "pinned"],
  );
  assert.deepEqual(
    selectProjectCards(cards, { query: "", showAll: true, sort: "blockers", now }).map(({ id }) => id),
    ["active", "pinned", "old"],
  );
  assert.deepEqual(
    selectProjectCards(cards, { query: "стар", showAll: true, sort: "cost", now }).map(({ id }) => id),
    ["old"],
  );
});

test("счётчики исходников сортируют расширения по объёму", () => {
  const counters = summarizeSourceCounters({
    trackedFiles: 12, trackedBytes: 300, complete: false, reason: "limit",
    byExtension: { ".bsl": 200, ".xml": 100 },
  });
  assert.deepEqual(counters.byExtension, [{ extension: ".bsl", bytes: 200 }, { extension: ".xml", bytes: 100 }]);
  assert.equal(counters.complete, false);
});

test("дерево тредов сохраняет вложенность и не теряет тред с невидимым родителем", () => {
  const rows: ProjectThreadRow[] = [
    { id: "root", parentThreadId: null, title: "Корень", titleFallback: null, status: "idle", displayStatus: null, updatedAt: 1, environmentId: null, taskLabel: null },
    { id: "child", parentThreadId: "root", title: null, titleFallback: "Ребёнок", status: "active", displayStatus: null, updatedAt: 3, environmentId: null, taskLabel: "ABC-1" },
    { id: "orphan", parentThreadId: "hidden", title: "Сирота", titleFallback: null, status: "idle", displayStatus: null, updatedAt: 2, environmentId: null, taskLabel: null },
  ];
  const forest = buildProjectThreadForest(rows);
  assert.deepEqual(forest.map(({ id }) => id), ["orphan", "root"]);
  assert.equal(forest[1].children[0].id, "child");
  const flat = flattenThreadForest(forest);
  assert.deepEqual(flat.map(({ node, depth }) => `${node.id}:${depth}`), ["orphan:0", "root:0", "child:1"]);
});

test("дашборд принимает XML, EDT и несколько конфигураций из паспорта", () => {
  const snapshot = passportSchema.parse({
    sourceId: null,
    environmentId: "env-worktree",
    hostId: "host-local",
    snapshotAt: "2026-11-25T10:00:00.000Z",
    configurations: [
      { root: ".", format: "xml", name: "Alpha", synonym: null, version: "1.2" },
      { root: "extension", format: "edt", name: "Beta", synonym: "Бета", version: "4.0" },
    ],
    ambiguous: false,
    configComplete: true,
    configError: null,
    metrics: { complete: true, trackedFiles: 2, trackedBytes: 1024, byExtension: { ".bsl": 1024 }, reason: null },
  });
  assert.deepEqual(snapshot.configurations.map(({ format, name }) => `${format}:${name}`), ["xml:Alpha", "edt:Beta"]);
  assert.equal(snapshot.sourceId, null);
  assert.equal(summarizeSourceCounters(snapshot.metrics).byExtension[0].extension, ".bsl");
});

function costTask(id: string, key: string, parentTaskId: string | null = null): CostTask {
  return { id, key, title: key, status: "in_progress", priority: "none", parentTaskId, updatedAt: 0 };
}

function costThread(threadId: string, totalTokens: number | null, overrides: Partial<CostThread> = {}): CostThread {
  return {
    threadId,
    title: threadId,
    parentThreadId: null,
    providerId: "codex",
    modelId: "gpt",
    status: totalTokens === null ? "unreported" : "reported",
    usage: totalTokens === null ? null : { inputTokens: totalTokens - 10, outputTokens: 10, cachedInputTokens: 0, totalTokens, at: 1 },
    lastTurnTokens: totalTokens === null ? null : 5,
    cost: null,
    ...overrides,
  };
}

test("расход сходится по задачам, подзадачам и строке «Без задачи» без двойного счёта", () => {
  const tasks = [costTask("t1", "AAA-1"), costTask("t2", "AAA-2", "t1")];
  const threads = [
    costThread("thread-a", 100),
    costThread("thread-b", 50, { parentThreadId: "thread-a" }),
    costThread("thread-c", 30),
    costThread("thread-d", null),
    costThread("thread-e", 0, { status: "error", usage: null }),
  ];
  const summary = summarizeTaskCost(tasks, [
    { taskId: "t2", threadId: "thread-b", attachedAt: 10 },
    { taskId: "t1", threadId: "thread-a", attachedAt: 10 },
    { taskId: "t2", threadId: "thread-a", attachedAt: 20 },
  ], threads);
  assert.equal(summary.totals.totalTokens, 180);
  assert.equal(summary.unassigned.total.totalTokens, 30);
  assert.equal(summary.tasks[0].task.key, "AAA-1");
  assert.equal(summary.tasks[0].own.totalTokens, 100);
  assert.equal(summary.tasks[0].total.totalTokens, 150);
  assert.equal(summary.tasks[0].children[0].own.totalTokens, 50);
  assert.equal(summary.duplicateLinks, 1);
  assert.equal(summary.coverage.linkedThreads, 2);
  assert.equal(summary.coverage.reported, 3);
  assert.equal(summary.coverage.failed, 1);
  assert.equal(summary.byProviderModel[0].threads, 3);
});

test("сумма по провайдерам и моделям сходится с общим итогом", () => {
  const tasks = [costTask("t1", "A-1")];
  const threads = [
    costThread("a", 100, { providerId: "codex", modelId: "gpt" }),
    costThread("b", 50, { providerId: "codex", modelId: "gpt" }),
    costThread("c", 25, { providerId: "opencode2", modelId: "kimi" }),
    costThread("d", 5, { providerId: "opencode2", modelId: "kimi" }),
  ];
  const summary = summarizeTaskCost(tasks, [], threads);
  assert.equal(summary.byProviderModel.reduce((sum, row) => sum + row.totalTokens, 0), summary.totals.totalTokens);
  assert.equal(summary.totals.totalTokens, 180);
  assert.deepEqual(summary.byProviderModel.map(({ providerId, modelId, threads: count }) => [providerId, modelId, count]), [
    ["codex", "gpt", 2],
    ["opencode2", "kimi", 2],
  ]);
});

test("расход без задачи остаётся видимым, а ссылка на неизвестную задачу не теряет тред", () => {
  const summary = summarizeTaskCost([costTask("t1", "A-1")], [
    { taskId: "missing", threadId: "thread-a", attachedAt: 1 },
  ], [costThread("thread-a", 40)]);
  assert.equal(summary.orphanLinks, 1);
  assert.equal(summary.unassigned.total.totalTokens, 40);
  assert.equal(summary.tasks[0].total.totalTokens, 0);
});

function operation(overrides: Partial<OperationEntry> & Pick<OperationEntry, "id" | "action">): OperationEntry {
  return {
    profile: "test",
    kind: "test",
    state: "done",
    startedAt: "2026-11-20T10:00:00.000Z",
    finishedAt: "2026-11-20T10:05:00.000Z",
    revision: "rev-1",
    dirty: false,
    needsInspection: false,
    counts: null,
    reports: [],
    ...overrides,
  };
}

test("свежесть отчёта, сравнение прогонов и расхождение ревизии считаются явно", () => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  const summary = summarizeQuality([
    operation({ id: "old", action: "yaxunit", finishedAt: "2026-11-01T10:05:00.000Z", counts: { tests: 90, failures: 4, errors: 1, skipped: 2 } }),
    operation({ id: "new", action: "yaxunit", finishedAt: "2026-11-24T10:05:00.000Z", revision: "rev-2", counts: { tests: 100, failures: 1, errors: 0, skipped: 3 } }),
    operation({ id: "load", action: "update-db", kind: "test", finishedAt: "2026-11-23T10:05:00.000Z", revision: "rev-1" }),
    operation({ id: "build", action: "build-configuration", finishedAt: "2026-11-22T10:05:00.000Z" }),
  ], { now, sourceRevision: "rev-2" });
  assert.equal(summary.latestTest?.id, "new");
  assert.equal(summary.previousTest?.id, "old");
  assert.deepEqual(summary.testDelta, { tests: 10, failures: -3, errors: -1, skipped: 1 });
  assert.equal(summary.testFresh, true);
  assert.equal(summary.latestBuild?.id, "build");
  assert.equal(summary.latestLoad?.id, "load");
  assert.equal(summary.revisionMismatch?.loaded, "rev-1");
  assert.equal(summary.revisionMismatch?.source, "rev-2");

  const stale = summarizeQuality([operation({ id: "old", action: "yaxunit", finishedAt: "2026-11-01T10:05:00.000Z" })], { now, sourceRevision: "rev-2" });
  assert.equal(stale.testFresh, false);
  assert.match(stale.testStaleReason ?? "", /старше/);
  assert.equal(stale.testDelta, null);

  const unknown = summarizeQuality([operation({ id: "new", action: "yaxunit", finishedAt: "2026-11-24T10:05:00.000Z" })], { now });
  assert.equal(unknown.testFresh, null);
  assert.match(unknown.testStaleReason ?? "", /текущая ревизия недоступна/);
});

test("после неудачной загрузки состояние базы остаётся неподтверждённым", () => {
  const successful = operation({ id: "confirmed", action: "load-xml", revision: "rev-1" });
  const failed = operation({
    id: "failed", action: "load-xml", state: "failed", revision: "rev-2", needsInspection: true,
    startedAt: "2026-11-21T10:00:00Z", finishedAt: "2026-11-21T10:05:00Z",
  });
  for (const entries of [[failed], [successful, failed]]) {
    const summary = summarizeQuality(entries, { sourceRevision: "rev-3" });
    assert.equal(summary.latestLoad?.id, "failed");
    assert.equal(summary.revisionMismatch, null);
    assert.equal(summary.confirmedLoadRevision, null);
  }

  const recovered = operation({
    ...failed, id: "recovered", state: "done", revision: "rev-3", needsInspection: false,
    startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:05:00Z",
  });
  const summary = summarizeQuality([successful, failed, recovered], { sourceRevision: "rev-4" });
  assert.equal(summary.confirmedLoadRevision, "rev-3");
  assert.equal(summary.revisionMismatch?.loaded, "rev-3");
});

test("загрузка без подтверждения или записанной ревизии не даёт расхождения", () => {
  for (const load of [
    operation({ id: "cancelled", action: "load-xml", state: "cancelled" }),
    operation({ id: "running", action: "load-xml", state: "running", finishedAt: null }),
    operation({ id: "interrupted", action: "load-xml", state: "interrupted", needsInspection: true }),
    operation({ id: "inspection", action: "load-xml", needsInspection: true }),
    operation({ id: "unknown-revision", action: "load-xml", revision: null }),
  ]) {
    const summary = summarizeQuality([load], { sourceRevision: "rev-2" });
    assert.equal(summary.latestLoad?.id, load.id);
    assert.equal(summary.confirmedLoadRevision, null);
    assert.equal(summary.revisionMismatch, null);
  }
});

test("сводка OpenSpec считает блокировки и блокеры BSL Flow", () => {
  const summary = summarizeOpenSpec({
    changes: [
      {
        id: "c1", title: "Один", archived: false, done: 1, total: 3, error: null, updatedAt: 10,
        bslFlow: { complexity: "M", spec: true, review: "blocked" },
        threads: [{ id: "thr_1", status: "active", managedTaskStatus: { stage: "implement", status: "blocked", blockers: ["нет ревью"] } }],
      },
      {
        id: "c2", title: "Два", archived: false, done: 2, total: 2, error: null, updatedAt: 20,
        threads: [],
      },
      {
        id: "c3", title: "Архив", archived: true, done: 0, total: 9, error: null, updatedAt: 30,
        bslFlow: { complexity: "L", spec: true, review: "blocked" },
        threads: [],
      },
    ],
  }, "env", null);
  assert.equal(summary.total, 2);
  assert.equal(summary.active, 1);
  assert.equal(summary.blockedReviews, 1);
  assert.deepEqual(summary.blockers, ["нет ревью"]);
  assert.deepEqual(summary.stages, ["implement"]);
  assert.equal(summary.done, 3);
  assert.equal(summary.totalTasks, 5);
  assert.equal(summary.updatedAt, 20);
});

test("журнал операций раскладывается на сборки и тесты с завершённым состоянием", () => {
  const events = operationActivityEvents([
    operation({ id: "y", action: "yaxunit", counts: { tests: 5, failures: 0, errors: 0, skipped: 0 } }),
    operation({ id: "d", action: "dump-xml" }),
    operation({ id: "run", action: "dump-xml", state: "running", finishedAt: null }),
    operation({ id: "open", action: "open-enterprise" }),
  ], "p1");
  assert.deepEqual(events.map(({ id, metric }) => `${id}:${metric}`), ["y:tests", "d:builds"]);
  assert.equal(events[0].projectId, "p1");
});

test("события задач получают проект при загрузке", () => {
  const events = taskActivityEvents([
    { id: "task1", key: "A-1", title: "Задача", status: "todo", priority: "none", parentTaskId: null, updatedAt: 123 },
  ], "p1");
  assert.equal(events.length, 1);
  assert.equal(events[0].metric, "tasks");
  assert.equal(events[0].projectId, "p1");
  assert.equal(events[0].at, 123);
});
