/**
 * Quality, test and operation rows for one project.
 *
 * Source: the read-only `1c-properties.platformDashboardV1` contract. It
 * carries the profile, state, recorded revision and test counts. A report is
 * fresh only when it finished inside the freshness window and, when the current
 * source revision is known, matches it.
 */

export interface OperationCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

export interface OperationReport {
  id: string;
  name: string;
}

export interface OperationEntry {
  id: string;
  action: string;
  profile: string;
  kind: string;
  state: "running" | "launched" | "done" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  revision: string | null;
  dirty: boolean | null;
  needsInspection: boolean;
  counts: OperationCounts | null;
  reports: OperationReport[];
}

export interface CountDelta {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

export interface QualitySummary {
  entries: OperationEntry[];
  latestTest: OperationEntry | null;
  previousTest: OperationEntry | null;
  testDelta: CountDelta | null;
  testFresh: boolean | null;
  testStaleReason: string | null;
  latestBuild: OperationEntry | null;
  latestLoad: OperationEntry | null;
  confirmedLoadRevision: string | null;
  revisionMismatch: { loaded: string; source: string; at: number; action: string } | null;
}

const testActions = new Set(["yaxunit", "vanessa", "check-syntax"]);
const buildActions = new Set([
  "dump-xml", "dump-binary", "build-configuration", "build-external", "unpack-configuration", "unpack-external",
]);
const loadActions = new Set(["load-xml", "load-binary", "update-db", "restore-dt"]);
export const defaultFreshnessMs = 7 * 24 * 60 * 60 * 1000;

export function isTestAction(action: string): boolean {
  return testActions.has(action);
}

export function isBuildAction(action: string): boolean {
  return buildActions.has(action);
}

export function isLoadAction(action: string): boolean {
  return loadActions.has(action);
}

function finishedAt(entry: OperationEntry): number | null {
  if (!entry.finishedAt) return null;
  const value = Date.parse(entry.finishedAt);
  return Number.isFinite(value) ? value : null;
}

function byRecency(a: OperationEntry, b: OperationEntry): number {
  return (finishedAt(b) ?? Date.parse(b.startedAt)) - (finishedAt(a) ?? Date.parse(a.startedAt));
}

function delta(latest: OperationCounts | null, previous: OperationCounts | null): CountDelta | null {
  if (!latest || !previous) return null;
  return {
    tests: latest.tests - previous.tests,
    failures: latest.failures - previous.failures,
    errors: latest.errors - previous.errors,
    skipped: latest.skipped - previous.skipped,
  };
}

export function summarizeQuality(
  entries: readonly OperationEntry[],
  options: { now?: number; sourceRevision?: string | null; freshAfterMs?: number } = {},
): QualitySummary {
  const now = options.now ?? Date.now();
  const freshAfterMs = options.freshAfterMs ?? defaultFreshnessMs;
  const ordered = entries.slice().sort(byRecency);
  const tests = ordered.filter((entry) => isTestAction(entry.action));
  const latestTest = tests[0] ?? null;
  const previousTest = latestTest
    ? tests.find((entry) => entry.action === latestTest.action && entry.profile === latestTest.profile && entry.id !== latestTest.id) ?? null
    : null;

  let testFresh: boolean | null = null;
  let testStaleReason: string | null = null;
  if (latestTest) {
    const finished = finishedAt(latestTest);
    if (finished === null) {
      testFresh = false;
      testStaleReason = "Прогон ещё не завершён";
    } else if (now - finished > freshAfterMs) {
      testFresh = false;
      testStaleReason = "Отчёт старше окна свежести";
    } else if (options.sourceRevision && latestTest.revision && latestTest.revision !== options.sourceRevision) {
      testFresh = false;
      testStaleReason = "Ревизия отчёта не совпадает с текущими исходниками";
    } else if (!latestTest.revision) {
      testFresh = null;
      testStaleReason = "Ревизия отчёта не записана";
    } else {
      testFresh = true;
    }
  }

  const latestBuild = ordered.find((entry) => isBuildAction(entry.action) && (entry.state === "done" || entry.state === "failed")) ?? null;
  const latestLoad = ordered.find((entry) => isLoadAction(entry.action)) ?? null;
  const confirmedLoadRevision = latestLoad?.state === "done" && !latestLoad.needsInspection
    ? latestLoad.revision
    : null;
  const mismatch = latestLoad && confirmedLoadRevision && options.sourceRevision && confirmedLoadRevision !== options.sourceRevision
    ? { loaded: confirmedLoadRevision, source: options.sourceRevision, at: finishedAt(latestLoad) ?? Date.parse(latestLoad.startedAt), action: latestLoad.action }
    : null;

  return {
    entries: ordered,
    latestTest,
    previousTest,
    testDelta: delta(latestTest?.counts ?? null, previousTest?.counts ?? null),
    testFresh,
    testStaleReason,
    latestBuild,
    latestLoad,
    confirmedLoadRevision,
    revisionMismatch: mismatch,
  };
}

export const operationActionLabels: Readonly<Record<string, string>> = {
  "dump-xml": "Выгрузка XML",
  "load-xml": "Загрузка XML",
  "dump-binary": "Сохранение CF/CFE",
  "load-binary": "Загрузка CF/CFE",
  "build-configuration": "Сборка конфигурации",
  "unpack-configuration": "Разбор конфигурации",
  "build-external": "Сборка EPF/ERF",
  "unpack-external": "Разбор EPF/ERF",
  "create-file-base": "Создание FILE-базы",
  "open-enterprise": "Запуск Предприятия",
  "open-designer": "Запуск Конфигуратора",
  "dump-dt": "Выгрузка DT",
  "restore-dt": "Восстановление DT",
  "update-db": "Обновление конфигурации БД",
  "check-syntax": "Синтаксический контроль",
  yaxunit: "YAxUnit",
  vanessa: "Vanessa Automation",
};

export const operationStateLabels: Readonly<Record<string, string>> = {
  running: "Выполняется",
  launched: "Запущено",
  done: "Готово",
  failed: "Ошибка",
  cancelled: "Отменено",
  interrupted: "Прервано",
};
