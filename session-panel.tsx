import { useEffect, useState } from "react";
import { experimental_Diff as Diff, experimental_useAppPanel, experimental_useProviders, UrlLink, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { readSessionOverview, type SessionOverview } from "./lib/session-overview.js";
import { readUncommittedFiles, readUncommittedPatch } from "./lib/git-status.js";
import { SessionTelemetry } from "./session-telemetry.js";

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
  return <section className="session-section" aria-label="Git">
    <h3>Git</h3>
    {git?.outcome === "not_applicable" ? <p>В окружении нет Git.</p> : <>
      {git?.outcome === "available"
        ? <>
          <p>{git.branch ?? "Ветка не определена"} · изменённых файлов: {git.changedFiles}</p>
          <button type="button" onClick={openDiff}>{showDiff ? "Свернуть дифф" : "Открыть дифф"}</button>
          {showDiff && workspace && <WorktreeDiff key={workspace.environment.id} environmentId={workspace.environment.id} />}
        </>
        : <p>Состояние Git недоступно.</p>}
      {pullRequest?.outcome === "available" ? <>
        <p><UrlLink href={pullRequest.pullRequest.url}>PR #{pullRequest.pullRequest.number} · {pullRequest.pullRequest.title}</UrlLink></p>
        <p>Проверки: {checksLabels[pullRequest.pullRequest.checks.state]} · {pullRequest.pullRequest.checks.passedCount} из {pullRequest.pullRequest.checks.totalCount}</p>
        <small>PR обновлён {formatTime(pullRequest.pullRequest.updatedAt)}</small>
      </> : <p>{pullRequest?.outcome === "absent" ? "Для окружения нет PR." : "Данные PR и проверок недоступны."}</p>}
    </>}
  </section>;
}

function WorkSection({ overview }: { overview: SessionOverview }) {
  const { openSpec, thread, tasks } = overview;
  const environmentId = thread.environmentId;
  const status = openSpec?.kind === "linked" ? openSpec.binding?.managedTaskStatus : null;
  return <section className="session-section" aria-label="Работа">
    <h3>Работа</h3>
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
  return <div className="session-panel">
    <div className="session-actions">
      <h2>Сессия</h2>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Обновить</button>
    </div>
    <section className="session-section" aria-label="Проект и окружение">
      <h3>Проект и окружение</h3>
      {project ? <button type="button" onClick={() => navigate.toProject(project.id)}>{project.name}</button> : <p>Данные проекта недоступны.</p>}
      <p>Машина: {workspace?.host?.name ?? hostId ?? "нет данных"}</p>
      <p>Окружение: {workspace?.environment.name ?? environmentId ?? "не назначено"}</p>
      {workspace?.environment.path && <p>{workspace.environment.path}</p>}
    </section>
    <GitSection workspace={workspace} />
    <WorkSection overview={result} />
    <section className="session-section" aria-label="Связанные треды">
      <div className="session-actions">
        <h3>Связанные треды</h3>
        <button type="button" onClick={() => panel.openTab({ tab: { id: "agents", context: { kind: "thread" }, availability: "action" } })}>Агенты</button>
      </div>
      {parent && <p>Родитель: <button type="button" onClick={() => navigate.toThread(parent.id)}>{threadTitle(parent)}</button></p>}
      {!parent && thread.parentThreadId && <p>Родительский тред недоступен.</p>}
      {children?.length ? <ul>{children.slice(0, 20).map((child) =>
        <li key={child.id}><button type="button" onClick={() => navigate.toThread(child.id)}>{threadTitle(child)}</button></li>
      )}</ul> : <p>{children ? "Нет видимых дочерних тредов." : "Список дочерних тредов недоступен."}</p>}
      {children && children.length > 20 && <p>Ещё треды доступны во вкладке «Агенты».</p>}
    </section>
    <section className="session-section" aria-label="Контекст и ход">
      <h3>Контекст и ход</h3>
      <p>{providerName}{model ? ` · ${model}` : " · модель неизвестна"}</p>
      <p>{window
        ? `Окно: ${window.usedTokens.toLocaleString()} / ${window.modelContextWindow.toLocaleString()} токенов${window.estimated ? " · оценка" : ""}`
        : usage?.data.tokenUsage.modelContextWindow != null
          ? `Размер окна: ${usage.data.tokenUsage.modelContextWindow.toLocaleString()} токенов · использование неизвестно`
          : "Использование окна контекста недоступно."}</p>
      {window && <small>{windowTime === null ? "Время замера неизвестно" : `Снимок BB · ${formatTime(windowTime)}`}</small>}
      {turn ? <p>{turn.type === "turn/started" ? "Ход начался" : "Ход завершился"} {formatTime(turn.createdAt)}</p> : <p>Время последнего хода недоступно.</p>}
      {lastUsage && usage ? <>
        <p>Последний отчёт: {lastUsage.inputTokens.toLocaleString()} входных и {lastUsage.outputTokens.toLocaleString()} выходных токенов · кэш: {lastUsage.cachedInputTokens.toLocaleString()}</p>
        <small>Статистика провайдера · {formatTime(usage.createdAt)}</small>
      </> : <p>Статистика токенов недоступна.</p>}
    </section>
    <SessionTelemetry key={JSON.stringify([threadId, thread.providerId, model, hostId, workspacePath])} threadId={threadId} providerId={thread.providerId} hostId={hostId} workspacePath={workspacePath} />
  </div>;
}

export function SessionPanel(props: ExperimentalThreadTabProps) {
  return <SessionContent key={JSON.stringify([props.threadId, props.environment?.id])} {...props} />;
}
