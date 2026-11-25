import { useEffect, useState } from "react";
import { experimental_Diff as Diff, experimental_useAppPanel, experimental_useProviders, UrlLink, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { readSessionOverview, type SessionOverview } from "./lib/session-overview.js";
import { readUncommittedFiles, readUncommittedPatch } from "./lib/git-status.js";
import { SessionTelemetry } from "./session-telemetry.js";
import { moneyLabel, percentLabel, SessionMeter, SessionRow } from "./session-rows.js";

const checksLabels = {
  passing: "Пройдены",
  failing: "Есть ошибки",
  pending: "Выполняются",
  no_checks: "Проверок нет",
  unknown: "Статус неизвестен",
};

const reviewLabels = {
  unknown: "Статус неизвестен",
  optional: "По необходимости",
  required: "Требуется",
  "awaiting-validation": "Ожидает валидации",
  blocked: "Заблокировано",
  stale: "Требуется обновить",
  passed: "Пройдено",
  limited: "Пройдено с ограничениями",
};

function formatTime(value: number | string) {
  return new Date(value).toLocaleString();
}

function threadTitle(thread: Pick<SessionOverview["thread"], "id" | "title" | "titleFallback">) {
  return thread.title || thread.titleFallback || thread.id;
}

function WorktreeDiff({ environmentId }: { environmentId: string }) {
  const sdk = useSdk();
  const [result, setResult] = useState<Awaited<ReturnType<typeof readUncommittedFiles>> | null>();
  const [path, setPath] = useState("");
  const [loaded, setLoaded] = useState<{ path: string; revision: string; patch: Awaited<ReturnType<typeof readUncommittedPatch>> }>();
  const files = result?.outcome === "available" ? result : null;
  const file = files?.files.find((row) => row.path === path);
  const initial = files?.initialPatches.find((row) => row.path === path);
  const patch = initial ?? (file && loaded?.path === file.path && loaded.revision === file.revision ? loaded.patch : undefined);

  useEffect(() => {
    const controller = new AbortController();
    void readUncommittedFiles(sdk, environmentId, controller.signal).then((snapshot) => {
      if (!controller.signal.aborted) setResult(snapshot);
    }).catch(() => {
      if (!controller.signal.aborted) setResult(null);
    });
    return () => controller.abort();
  }, [sdk, environmentId]);

  useEffect(() => {
    if (!file || file.binary || initial) return;
    const controller = new AbortController();
    void readUncommittedPatch(sdk, environmentId, file.path, file.revision, controller.signal).catch(() => null).then((snapshot) => {
      if (!controller.signal.aborted) setLoaded({ path: file.path, revision: file.revision, patch: snapshot });
    });
    return () => controller.abort();
  }, [sdk, environmentId, file, initial]);

  if (!files) return <p role="status">{result === undefined ? "Загрузка диффа…" : "Дифф недоступен."}</p>;
  if (!files.files.length) return <p>Незакоммиченных изменений нет.</p>;
  return <>
    <label>Изменённый файл <select value={path} onChange={(event) => setPath(event.currentTarget.value)}>
      <option value="">Выбрать файл</option>
      {files.files.map((row) => <option key={row.path} value={row.path}>{row.path}</option>)}
    </select></label>
    {files.truncated && <p>Список файлов ограничен источником Git.</p>}
    {file?.binary ? <p>Изменился двоичный файл.</p> : file && (
      patch?.patch ? <>
        {patch.truncated && <p>Дифф усечён источником Git.</p>}
        <Diff path={file.path} patch={patch.patch} />
      </> : <p role="status">{patch === undefined ? "Загрузка изменений файла…" : "Текстовый дифф файла недоступен."}</p>
    )}
  </>;
}

function GitSection({ workspace }: { workspace: SessionOverview["workspace"] }) {
  const panel = experimental_useAppPanel();
  const [showDiff, setShowDiff] = useState(false);
  const { git, pullRequest } = workspace ?? {};
  const openDiff = () => {
    const tab = panel.getTabs().tabs.find(({ detail }) =>
      detail.kind === "plugin" && detail.pluginId === "bb--git" && detail.tab.id === "diff");
    if (!tab || !panel.selectTab(tab.key)) setShowDiff((visible) => !visible);
  };
  return <div className="session-git" aria-label="Git">
    {git?.outcome === "not_applicable" ? <SessionRow label="Git">В окружении нет Git</SessionRow> : <>
      {git?.outcome === "available"
        ? <>
          <SessionRow label="Ветка">{git.branch ?? "Нет данных"}</SessionRow>
          <SessionRow label={<button type="button" onClick={openDiff}>{showDiff ? "Свернуть дифф" : "Открыть дифф"}</button>}>
            {git.changedFiles} файл.
          </SessionRow>
          {showDiff && workspace && <WorktreeDiff key={workspace.environment.id} environmentId={workspace.environment.id} />}
        </>
        : <SessionRow label="Git">Нет данных</SessionRow>}
      {pullRequest?.outcome === "available" ? <>
        <SessionRow label={<UrlLink href={pullRequest.pullRequest.url}>{pullRequest.pullRequest.title}</UrlLink>}>#{pullRequest.pullRequest.number}</SessionRow>
        <SessionRow label="Проверки">
          <span title={checksLabels[pullRequest.pullRequest.checks.state]}>{pullRequest.pullRequest.checks.passedCount}/{pullRequest.pullRequest.checks.totalCount}</span>
        </SessionRow>
      </> : null}
    </>}
  </div>;
}

function WorkSection({ overview }: { overview: SessionOverview }) {
  const { openSpec, thread, tasks } = overview;
  const environmentId = thread.environmentId;
  const status = openSpec?.kind === "linked" ? openSpec.binding?.managedTaskStatus : null;
  const linkedCount = (openSpec?.kind === "linked" ? 1 : 0) + (tasks?.filter(Boolean).length ?? 0);
  const linksComplete = tasks !== null && (openSpec?.kind === "linked" || openSpec?.kind === "unlinked");
  return <section className="session-section" aria-label="Работа">
    <details open={openSpec?.kind === "linked" || !!tasks?.length}>
    <summary>Работа <span>{linksComplete ? linkedCount : linkedCount ? `≥${linkedCount}` : "Нет данных"}</span></summary>
    {openSpec?.kind === "linked" && environmentId ? <>
      <p><UrlLink href={openSpec.storeId
        ? "/plugins/openspec-bsl-flow/openspec"
        : `/plugins/openspec-bsl-flow/openspec/${encodeURIComponent(environmentId)}/${encodeURIComponent(openSpec.changeId)}`}>
        {openSpec.change?.title || openSpec.changeId}
      </UrlLink></p>
      {openSpec.change
        ? <p>OpenSpec · выполнено {openSpec.change.done} из {openSpec.change.total}</p>
        : <p>Состояние связанного изменения недоступно.</p>}
      {openSpec.change?.error && <p role="status">OpenSpec сообщил об ошибке чтения изменения.</p>}
      {openSpec.change?.bslFlow && <p>BSL Flow · ревью: {reviewLabels[openSpec.change.bslFlow.review]}</p>}
      {status && <>
        <p>Задача BSL Flow: {status.status}{status.stage ? ` · ${status.stage}` : ""}</p>
        {status.blockers.length > 0 && <ul aria-label="Блокеры BSL Flow">{status.blockers.map((blocker, index) =>
          <li key={index}>{blocker}</li>)}</ul>}
      </>}
      {!status && openSpec.binding?.managedTaskId && <p>Статус управляемой задачи BSL Flow недоступен.</p>}
    </> : <p>{openSpec?.kind === "unlinked" ? "К треду не привязано изменение OpenSpec." : "Данные OpenSpec недоступны."}</p>}
    {tasks?.map((task) => task && <p key={task.key}>
      <UrlLink href={`/plugins/tasks/tasks/task/${encodeURIComponent(task.key)}`}>{task.key} · {task.title}</UrlLink> · {task.status}
    </p>)}
    <p><UrlLink href="/plugins/tasks/tasks">BB Tasks</UrlLink>{!tasks ? " · связи недоступны" : !tasks.length ? " · активные связи не найдены" : ""}</p>
    </details>
  </section>;
}

function SessionContent({ threadId, environment }: ExperimentalThreadTabProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const { providers } = experimental_useProviders();
  const environmentId = environment?.id ?? null;
  const [result, setResult] = useState<SessionOverview | null | undefined>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let pending = false;
    const load = async () => {
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await readSessionOverview(sdk, threadId, environmentId, controller.signal);
        if (!controller.signal.aborted) setResult(snapshot);
      } catch {
        if (!controller.signal.aborted) setResult(null);
      } finally {
        refreshing = false;
        if (pending && !controller.signal.aborted) {
          pending = false;
          scheduleLoad();
        }
      }
    };
    const scheduleLoad = () => {
      if (timer === undefined) timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, 500);
    };
    const unsubscribeThread = sdk.subscribe({ event: "thread:changed", threadId, callback: scheduleLoad });
    const unsubscribeEnvironment = environmentId
      ? sdk.subscribe({ event: "environment:changed", environmentId, callback: scheduleLoad })
      : undefined;
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribeThread();
      unsubscribeEnvironment?.();
    };
  }, [sdk, threadId, environmentId, refresh]);

  if (!result) return <div className="session-panel">
    {result === undefined ? <p role="status">Загрузка сводки…</p> : <>
      <p role="status">Сводка треда недоступна.</p>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Повторить</button>
    </>}
  </div>;

  const { thread, project, workspace, parent, children, window, windowTime, turn, usage, model } = result;
  const providerName = providers.find(({ id }) => id === thread.providerId)?.displayName ?? thread.providerId;
  const hostId = workspace?.environment.hostId ?? null;
  const workspacePath = workspace?.environment.path ?? null;
  const lastUsage = usage?.data.tokenUsage.last;
  const reportedCapacity = usage?.data.tokenUsage.modelContextWindow;
  const contextPercent = window && window.modelContextWindow > 0 ? 100 * window.usedTokens / window.modelContextWindow : null;
  const cacheHit = lastUsage && lastUsage.inputTokens > 0 && lastUsage.cachedInputTokens <= lastUsage.inputTokens
    ? 100 * lastUsage.cachedInputTokens / lastUsage.inputTokens : null;
  const categories = window?.snapshot?.categories.filter(({ kind }) => kind !== "free") ?? [];
  return <div className="session-panel session-compact">
    <div className="session-heading session-top">
      <h2>Сессия</h2>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Обновить</button>
    </div>
    <section className="session-section session-context">
      <SessionRow label="Контекст">{contextPercent === null ? "Нет данных" : percentLabel(contextPercent)}</SessionRow>
      {contextPercent !== null && <SessionMeter label="Использование окна контекста" percent={contextPercent} />}
      {window ? <small>
        {window.usedTokens.toLocaleString()} / {window.modelContextWindow.toLocaleString()} токенов
        {window.estimated ? " · оценка" : ""}
        {windowTime !== null && <span title={formatTime(windowTime)}> · снимок BB</span>}
      </small> : reportedCapacity ? <small>Окно {reportedCapacity.toLocaleString()} токенов</small> : null}
      <SessionRow label="Попадание в кэш">{cacheHit === null ? "Нет данных" : percentLabel(cacheHit)}</SessionRow>
    </section>
    <section className="session-section" aria-label="Проект и окружение">
      <SessionRow label="Проект">{project ? <button type="button" onClick={() => navigate.toProject(project.id)}>{project.name}</button> : "Нет данных"}</SessionRow>
      <GitSection workspace={workspace} />
      <details>
        <summary>Рабочее окружение</summary>
        <SessionRow label="Машина">{workspace?.host?.name ?? hostId ?? "Нет данных"}</SessionRow>
        <SessionRow label="Окружение">{workspace?.environment.name ?? environmentId ?? "Не назначено"}</SessionRow>
        {workspacePath && <p className="session-path">{workspacePath}</p>}
      </details>
    </section>
    <WorkSection overview={result} />
    {!!categories.length && <section className="session-section" aria-label="Источники контекста">
      <details>
        <summary>Источники контекста <span>{categories.length}</span></summary>
        {categories.map((category) => <SessionRow key={category.id} label={category.label}>{category.tokens.toLocaleString()}</SessionRow>)}
      </details>
    </section>}
    <SessionTelemetry key={JSON.stringify([threadId, thread.providerId, model, hostId, workspacePath])} threadId={threadId} providerId={thread.providerId} hostId={hostId} workspacePath={workspacePath} />
    <section className="session-section" aria-label="Связанные треды">
      <SessionRow label={<button type="button" onClick={() => panel.openTab({ tab: { id: "agents", context: { kind: "thread" }, availability: "action" } })}>Агенты</button>}>
        {children ? children.length > 20 ? "20+" : children.length : "Нет данных"}
      </SessionRow>
      {(!!children?.length || parent || thread.parentThreadId) && <details>
      <summary>Связанные треды</summary>
      {parent && <p>Родитель: <button type="button" onClick={() => navigate.toThread(parent.id)}>{threadTitle(parent)}</button></p>}
      {!parent && thread.parentThreadId && <p>Родительский тред недоступен.</p>}
      {children?.length ? <ul>{children.slice(0, 20).map((child) =>
        <li key={child.id}><button type="button" onClick={() => navigate.toThread(child.id)}>{threadTitle(child)}</button></li>
      )}</ul> : <p>{children ? "Нет видимых дочерних тредов." : "Список дочерних тредов недоступен."}</p>}
      {children && children.length > 20 && <p>Ещё треды доступны во вкладке «Агенты».</p>}
      </details>}
    </section>
    <section className="session-section" aria-label="Последний ход">
      <details>
        <summary>Последний ход <span>{turn ? new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Нет данных"}</span></summary>
        <SessionRow label="Модель">{providerName}{model ? ` · ${model}` : ""}</SessionRow>
        {turn && <SessionRow label={turn.type === "turn/started" ? "Начало" : "Завершение"}>{formatTime(turn.createdAt)}</SessionRow>}
        {lastUsage && <>
          <SessionRow label="Входные токены">{lastUsage.inputTokens.toLocaleString()}</SessionRow>
          <SessionRow label="Токены из кэша">{lastUsage.cachedInputTokens.toLocaleString()}</SessionRow>
          <SessionRow label="Выходные токены">{lastUsage.outputTokens.toLocaleString()}</SessionRow>
        </>}
      </details>
    </section>
  </div>;
}

export function SessionPanel(props: ExperimentalThreadTabProps) {
  return <SessionContent key={JSON.stringify([props.threadId, props.environment?.id])} {...props} />;
}
