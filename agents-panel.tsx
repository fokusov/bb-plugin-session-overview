import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { UrlLink, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { buildAgentTree, formatAgentStatus, formatTokenCount, formatWorkflowAttemptStatus, parseOrchestrationMetadata, projectGraphRunAttempts, projectWorkflowAttempts, readAgentEvents, type AgentEvent, type AgentThread, type AgentTreeNode, type GraphRunAttempt, type WorkflowAgentAttempt } from "./lib/session-agents.js";

const TREE_REFRESH_MS = 10_000;
const MAX_TREE_THREADS = 200;
const MAX_LOCAL_CACHES = 20;
const crewMembersSchema = z.object({
  contractVersion: z.number(),
  members: z.array(z.object({ address: z.string(), crew: z.string(), role: z.string(), threadId: z.string().nullable() })),
});
const graphNodeRunSchema = z.object({
  id: z.string(), nodeId: z.string(), attempt: z.number(), status: z.string(),
  childThreadId: z.string().nullable(), startedAt: z.number().nullable(), endedAt: z.number().nullable(), error: z.string().nullable(),
});
const graphRunSchema = z.object({
  id: z.string(), graphId: z.string(), threadId: z.string().nullable(), projectId: z.string().nullable(), status: z.string(), updatedAt: z.number(),
  state: z.object({ visits: z.record(z.string(), z.number()) }), nodeRuns: z.array(graphNodeRunSchema),
});
const graphRunListSchema = z.object({ runs: z.array(graphRunSchema) });
const graphRunGetSchema = z.object({ run: graphRunSchema.nullable() });
type GraphRunRow = z.infer<typeof graphRunSchema>;
const selectedThreadByParent = new Map<string, string>();
type ReadState<T> = { threadId: string; status: "loading" } | { threadId: string; status: "error" } | { threadId: string; status: "ready"; value: T };
type WorktreeInfo = { name: string | null; path: string | null; isWorktree: boolean };

function setBounded<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_LOCAL_CACHES) map.delete(map.keys().next().value!);
}

function threadTitle(thread: AgentThread): string {
  return thread.title || thread.titleFallback || `Тред ${thread.id.slice(0, 8)}`;
}

function TreeItem({ node, selected, onSelect, depth = 0 }: { node: AgentTreeNode; selected: string; onSelect(id: string): void; depth?: number }) {
  return <>
    <button className="session-tree-item" type="button" role="treeitem" aria-current={selected === node.id ? "true" : undefined} style={{ paddingInlineStart: 8 + depth * 18 }} onClick={() => onSelect(node.id)}>
      <span>{threadTitle(node)}{(node.orchestration || node.crew) && <small className="session-agent-meta"> · {node.orchestration?.role ?? node.crew?.role}</small>}</span><small>{formatAgentStatus(node.displayStatus ?? node.status)}</small>
    </button>
    {node.children.map((child) => <TreeItem key={child.id} node={child} selected={selected} onSelect={onSelect} depth={depth + 1} />)}
  </>;
}

function eventDescription(event: AgentEvent): string {
  if (event.type === "item/delegation/progress" || event.type === "item/delegation/completed") {
    return event.data.item.summary || event.data.item.label || event.data.item.presentation?.detail || `Делегирование · ${event.data.providerThreadId}`;
  }
  if (event.type === "thread/contextWindowUsage/updated") return "Обновлён снимок окна контекста";
  if (event.type === "thread/context/cleared") return "Контекст очищен";
  if (event.type === "thread/tokenUsage/updated") return `Обновлена статистика токенов: ${formatTokenCount(event.data.tokenUsage.total.totalTokens)}`;
  if (event.type === "item/backgroundTask/progress" || event.type === "item/backgroundTask/completed") return event.data.item.type === "backgroundTask" ? event.data.item.workflowName || event.data.item.summary || event.data.item.description : "Фоновая задача";
  if (event.type === "turn/started") return "Начат ход агента";
  if (event.type === "turn/completed") return `Ход завершён: ${event.data.status}`;
  if (event.type === "turn/input/accepted") return "Принят ввод для треда";
  if (event.type === "client/turn/requested") return "Запрошен ход треда";
  return event.type;
}

function AgentsContent({ threadId, environment }: ExperimentalThreadTabProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [snapshot, setSnapshot] = useState({ threads: [] as AgentThread[], truncated: false });
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(() => selectedThreadByParent.get(threadId) ?? threadId);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [eventsState, setEventsState] = useState<ReadState<AgentEvent[]>>({ threadId: selectedId, status: "loading" });
  const [modelState, setModelState] = useState<ReadState<string | null>>({ threadId: selectedId, status: "loading" });
  const [worktreeState, setWorktreeState] = useState<ReadState<WorktreeInfo>>({ threadId: selectedId, status: "loading" });
  const [graphState, setGraphState] = useState<ReadState<GraphRunRow[]>>({ threadId, status: "loading" });
  const [graphRefreshTick, setGraphRefreshTick] = useState(0);

  useEffect(() => { setBounded(selectedThreadByParent, threadId, selectedId); }, [threadId, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const descendants = await sdk.threads.experimental_listDescendants({ threadIds: [threadId], signal: controller.signal });
        const allIds = [...new Set([threadId, ...(descendants.threads.find((row) => row.threadId === threadId)?.descendantIds ?? [])])];
        const ids = allIds.slice(0, MAX_TREE_THREADS);
        const rows = await sdk.threads.list({ threadIds: ids, includeHidden: false, limit: MAX_TREE_THREADS, signal: controller.signal });
        if (signal.aborted) return;
        const threads: AgentThread[] = rows.map(({ id, parentThreadId, title, titleFallback, status, runtime, providerId, environmentId, updatedAt, projectId }) => ({
          id, parentThreadId, title, titleFallback, status, displayStatus: runtime.displayStatus, providerId, environmentId, updatedAt, projectId,
        }));
        const metadataRows = await sdk.threads.experimental_listPluginMetadata({ pluginId: "1c-properties", threadIds: ids, signal: controller.signal }).catch(() => ({ threads: [] }));
        if (signal.aborted) return;
        const orchestrationByThread = new Map(metadataRows.threads.map(({ threadId, metadata }) => [threadId, parseOrchestrationMetadata(metadata.orchestration)]));
        for (const thread of threads) thread.orchestration = orchestrationByThread.get(thread.id);
        const projectId = threads.find(({ id }) => id === threadId)?.projectId;
        if (projectId) {
          const crewResult = await sdk.plugins.callRpc({ pluginId: "crew", method: "listMembers", input: { projectId }, outputSchema: crewMembersSchema, signal: controller.signal }).catch(() => null);
          if (crewResult?.contractVersion === 1) {
            const crewByThread = new Map(crewResult.members.flatMap((member) => member.threadId ? [[member.threadId, { address: member.address, crew: member.crew, role: member.role }] as const] : []));
            for (const thread of threads) thread.crew = crewByThread.get(thread.id);
          }
        }
        const next = { threads, truncated: allIds.length > rows.length };
        setSnapshot(next);
        setSelectedId((previous) => threads.some(({ id }) => id === previous) ? previous : threadId);
        setTreeError(null);
      } catch {
        if (!signal.aborted) {
          setSnapshot({ threads: [], truncated: false });
          setTreeError("Список видимых тредов недоступен.");
        }
      } finally {
        inFlight = false;
        if (!signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), TREE_REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sdk, threadId, refreshKey]);

  const selectedThread = snapshot.threads.find(({ id }) => id === selectedId) ?? null;
  const selectedUpdatedAt = selectedThread?.updatedAt;
  const rootProjectId = snapshot.threads.find(({ id }) => id === threadId)?.projectId;
  const selectedGraphRunId = selectedThread?.orchestration?.runId;
  useEffect(() => {
    const timer = setInterval(() => setGraphRefreshTick((tick) => tick + 1), TREE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setGraphState((previous) => previous.threadId === threadId ? previous : { threadId, status: "loading" });
    const listed = sdk.plugins.callRpc({ pluginId: "graph-studio", method: "listRuns", input: { threadId }, outputSchema: graphRunListSchema, signal: controller.signal })
      .then(({ runs }) => runs)
      .catch(() => null);
    const selected = selectedGraphRunId
      ? sdk.plugins.callRpc({ pluginId: "graph-studio", method: "getRun", input: { id: selectedGraphRunId }, outputSchema: graphRunGetSchema, signal: controller.signal })
        .then(({ run }) => run)
        .catch(() => null)
      : Promise.resolve(null);
    void Promise.all([listed, selected]).then(([runs, selectedRun]) => {
      if (disposed) return;
      if (!runs && !selectedRun) {
        setGraphState({ threadId, status: "error" });
        return;
      }
      const byId = new Map((runs ?? []).map((run) => [run.id, run]));
      const rootRuns = [...byId.values()].filter((run) => run.threadId === threadId && run.projectId === rootProjectId);
      if (selectedRun?.threadId === threadId && selectedRun.projectId === rootProjectId && !rootRuns.some(({ id }) => id === selectedRun.id)) rootRuns.push(selectedRun);
      setGraphState({ threadId, status: "ready", value: rootRuns });
    });
    return () => { disposed = true; controller.abort(); };
  }, [sdk, threadId, rootProjectId, selectedGraphRunId, refreshKey, graphRefreshTick]);
  useEffect(() => {
    if (selectedUpdatedAt === undefined) return;
    let disposed = false;
    const controller = new AbortController();
    void readAgentEvents(sdk.threads.events, selectedId, controller.signal)
      .then((events) => { if (!disposed) setEventsState({ threadId: selectedId, status: "ready", value: events }); })
      .catch(() => { if (!disposed && !controller.signal.aborted) setEventsState({ threadId: selectedId, status: "error" }); });
    return () => { disposed = true; controller.abort(); };
  }, [sdk, selectedId, selectedUpdatedAt, refreshKey]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setModelState({ threadId: selectedId, status: "loading" });
    void sdk.threads.defaultExecutionOptions({ threadId: selectedId, signal: controller.signal })
      .then((options) => { if (!disposed) setModelState({ threadId: selectedId, status: "ready", value: options?.model ?? null }); })
      .catch(() => { if (!disposed && !controller.signal.aborted) setModelState({ threadId: selectedId, status: "error" }); });
    return () => { disposed = true; controller.abort(); };
  }, [sdk, selectedId]);

  const selectedEnvironmentId = snapshot.threads.find(({ id }) => id === selectedId)?.environmentId ?? (selectedId === threadId ? environment?.id ?? null : null);
  useEffect(() => {
    let disposed = false;
    if (!selectedEnvironmentId) {
      setWorktreeState({ threadId: selectedId, status: "ready", value: { name: null, path: null, isWorktree: false } });
      return;
    }
    const controller = new AbortController();
    setWorktreeState({ threadId: selectedId, status: "loading" });
    void sdk.environments.get({ environmentId: selectedEnvironmentId, signal: controller.signal })
      .then((details) => { if (!disposed) setWorktreeState({ threadId: selectedId, status: "ready", value: { name: details.name, path: details.path, isWorktree: details.isWorktree } }); })
      .catch(() => { if (!disposed && !controller.signal.aborted) setWorktreeState({ threadId: selectedId, status: "error" }); });
    return () => { disposed = true; controller.abort(); };
  }, [sdk, selectedId, selectedEnvironmentId]);

  const tree = useMemo(() => buildAgentTree(threadId, snapshot.threads), [threadId, snapshot.threads]);
  const events = selectedThread && eventsState.threadId === selectedId && eventsState.status === "ready" ? eventsState.value : [];
  const selectedEvent = events.find(({ id }) => id === selectedEventId) ?? null;
  const [selectedAttemptKey, setSelectedAttemptKey] = useState<string | null>(null);
  const latest = [...events].reverse();
  const contextEvent = latest.find((event) => event.type === "thread/contextWindowUsage/updated" || event.type === "thread/context/cleared");
  const tokenEvent = latest.find((event) => event.type === "thread/tokenUsage/updated" || event.type === "thread/context/cleared");
  const nativeDelegations = events.filter((event) => event.type === "item/delegation/progress" || event.type === "item/delegation/completed");
  const attemptSources = events.flatMap((event) => {
    if ((event.type !== "item/backgroundTask/progress" && event.type !== "item/backgroundTask/completed") || event.data.item.type !== "backgroundTask" || !event.data.item.workflow?.agents.length) return [];
    return [{ eventId: event.id, threadId: event.threadId, taskId: event.data.item.id, agents: event.data.item.workflow.agents }];
  });
  const workflowAttempts = projectWorkflowAttempts(attemptSources);
  const workflowAttemptTruncated = attemptSources.reduce((total, source) => total + source.agents.length, 0) > 200;
  const selectedAttempt = workflowAttempts.find(({ key }) => key === selectedAttemptKey) ?? null;
  const graphAttempts = graphState.threadId === threadId && graphState.status === "ready"
    ? projectGraphRunAttempts(graphState.value.map((run) => ({
      id: run.id, graphId: run.graphId, threadId: run.threadId, status: run.status, updatedAt: run.updatedAt,
      visits: run.state.visits, nodeRuns: run.nodeRuns,
    })))
    : [];
  const attemptSourceEventIds = new Set(workflowAttempts.map(({ sourceEventId }) => sourceEventId));
  const timelineItems = [
    ...events.filter(({ id }) => !attemptSourceEventIds.has(id)).map((event) => ({ id: event.id, createdAt: event.createdAt, event, attempt: null as WorkflowAgentAttempt | null, description: eventDescription(event) })),
    ...workflowAttempts.map((attempt) => ({ id: attempt.key, createdAt: attempt.startedAt ?? attempt.queuedAt ?? attempt.lastProgressAt, event: events.find(({ id }) => id === attempt.sourceEventId)!, attempt, description: `${attempt.label} · попытка ${attempt.attempt} · ${formatWorkflowAttemptStatus(attempt.state)}` })),
  ].sort((a, b) => a.createdAt - b.createdAt);
  const modelLabel = modelState.threadId !== selectedId || modelState.status === "loading" ? "Загружаю…" : modelState.status === "error" ? "Не удалось получить" : modelState.value ?? "Не задана";
  const worktreeLabel = worktreeState.threadId !== selectedId || worktreeState.status === "loading" ? "Загружаю…" : worktreeState.status === "error" ? "Не удалось получить" : worktreeState.value.path || worktreeState.value.name || (selectedEnvironmentId ? "Путь не указан" : "Недоступно");

  return <main className="session-panel">
    <section className="session-section">
      <header className="session-actions"><h2>Агенты</h2><button type="button" disabled={!selectedThread} onClick={() => navigate.toThread(selectedId)}>Открыть чат</button><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>Обновить</button></header>
      <p>Видимые треды BB · автообновление раз в 10 секунд</p>
      {loading && <p role="status">Загружаю дерево тредов…</p>}
      {treeError && <p role="alert">{treeError}</p>}
      {snapshot.truncated && <p role="status">Дерево ограничено первыми {MAX_TREE_THREADS} тредами.</p>}
      {!loading && !treeError && !tree && <p>Текущий тред недоступен или скрыт.</p>}
      {tree && <div className="session-tree" role="tree" aria-label="Дерево тредов BB"><TreeItem node={tree} selected={selectedId} onSelect={(id) => {
        setSelectedId(id);
        setSelectedEventId(null);
        setSelectedAttemptKey(null);
        if (id !== selectedId) setEventsState({ threadId: id, status: "loading" });
      }} /></div>}
      {selectedId === threadId && eventsState.status === "ready" && nativeDelegations.length > 0 && <div className="session-native-delegations"><h3>Нативные делегации провайдера</h3>{nativeDelegations.map((event) => <button key={event.id} type="button" onClick={() => setSelectedEventId(event.id)}>{eventDescription(event)} · отдельный BB-тред не подтверждён</button>)}</div>}
    </section>

    <section className="session-section">
      <h3>{selectedThread ? threadTitle(selectedThread) : "Выбранный исполнитель"}</h3>
      {selectedThread ? <dl>
        <dt>Статус</dt><dd>{formatAgentStatus(selectedThread.displayStatus ?? selectedThread.status)}</dd>
        <dt>Провайдер</dt><dd>{selectedThread.providerId}</dd>
        <dt>Модель</dt><dd>{modelLabel}</dd>
        <dt>Поручение и роль</dt><dd>{selectedThread.orchestration ? <>{selectedThread.orchestration.taskId} · {selectedThread.orchestration.role}</> : "Нет отдельных подтверждённых полей у треда"}</dd>
        {selectedThread.orchestration?.runId && <><dt>Запуск Graph Studio</dt><dd>{selectedThread.orchestration.runId}</dd></>}
        {selectedThread.orchestration?.reviewMode && <><dt>Режим ревью</dt><dd>{selectedThread.orchestration.reviewMode}</dd></>}
        {selectedThread.orchestration && <><dt>Родительский тред</dt><dd><button type="button" onClick={() => navigate.toThread(selectedThread.orchestration!.parentThreadId)}>Открыть родительский тред</button></dd></>}
        {selectedThread.crew && <><dt>Crew</dt><dd>{selectedThread.crew.crew} · {selectedThread.crew.address} · {selectedThread.crew.role} <UrlLink href="/plugins/crew/crews">Открыть Crew</UrlLink></dd></>}
        <dt>Рабочее окружение</dt><dd>{worktreeLabel}{worktreeState.status === "ready" && worktreeState.threadId === selectedId && worktreeState.value.isWorktree ? " · worktree" : ""}</dd>
        <dt>Последняя активность</dt><dd>{new Date(selectedThread.updatedAt).toLocaleString("ru-RU")}</dd>
        <dt>Всего токенов</dt><dd>{tokenEvent?.type === "thread/tokenUsage/updated" ? formatTokenCount(tokenEvent.data.tokenUsage.total.totalTokens) : eventsState.status === "error" ? "Не удалось загрузить" : "Недоступно"}</dd>
      </dl> : <p>Контекст выбранного BB-треда пока не загружен.</p>}
      <h4>Окно контекста</h4>
      {contextEvent?.type === "thread/contextWindowUsage/updated" ? <ContextSnapshot event={contextEvent} /> : eventsState.status === "error" ? <p>Не удалось загрузить события треда.</p> : <p>Снимок контекста недоступен.</p>}
    </section>

    <section className="session-section">
      <h3>Graph Studio · попытки узлов</h3>
      {graphState.status === "loading" && <p role="status">Загружаю запуски Graph Studio…</p>}
      {graphState.status === "error" && <p>Graph Studio недоступен или запусков нет.</p>}
      {graphState.status === "ready" && graphAttempts.length === 0 && <p>Попыток узлов Graph Studio для этого треда нет.</p>}
      {graphAttempts.length > 0 && <ol className="session-timeline">{graphAttempts.map((attempt: GraphRunAttempt) => <li key={attempt.key}>
        <span>{attempt.graphId} · {attempt.nodeId} · попытка {attempt.attempt} · {attempt.status} · запуск {attempt.runId}</span>
        {attempt.nodeVisitCount != null && <small> · всего посещений узла в запуске: {attempt.nodeVisitCount}</small>}
        {attempt.childThreadId && <button type="button" onClick={() => navigate.toThread(attempt.childThreadId!)}>Открыть тред шага</button>}
        {attempt.error && <p>{attempt.error}</p>}
      </li>)}</ol>}
      {graphState.status === "ready" && graphState.value.length > 0 && <p>Число посещений узла — общий счётчик запуска.</p>}
    </section>

    <section className="session-section">
      <h3>Хронология событий</h3>
      {eventsState.status === "loading" && <p role="status">Загружаю события выбранного треда…</p>}
      {eventsState.status === "error" && <p role="alert">Не удалось загрузить историю событий.</p>}
      {workflowAttemptTruncated && <p role="status">Показаны последние 200 попыток workflow.</p>}
      {eventsState.status === "ready" && timelineItems.length === 0 && <p>Событий для выбранного треда нет.</p>}
      {timelineItems.length > 0 && <ol className="session-timeline">{timelineItems.map((item) => <li key={item.id}>
        <button type="button" aria-pressed={item.attempt ? selectedAttemptKey === item.attempt.key : selectedEventId === item.event.id} onClick={() => { setSelectedEventId(item.event.id); setSelectedAttemptKey(item.attempt?.key ?? null); }}><time>{new Date(item.createdAt).toLocaleTimeString("ru-RU")}</time> · {item.description}</button>
      </li>)}</ol>}
      {selectedEvent && <article className="session-event-inspector"><h4>Событие</h4><p>{eventDescription(selectedEvent)}</p><dl><dt>Источник</dt><dd>{selectedEvent.type}</dd><dt>Тред</dt><dd>{selectedEvent.threadId}</dd>{selectedEvent.scope.kind === "turn" && <><dt>Ход BB</dt><dd>{selectedEvent.scope.turnId}</dd></>}<dt>Последовательность</dt><dd>{selectedEvent.seq}</dd>{(selectedEvent.type === "item/delegation/progress" || selectedEvent.type === "item/delegation/completed") && <><dt>Provider thread ID</dt><dd>{selectedEvent.data.providerThreadId}</dd><dt>Статус делегирования</dt><dd>{selectedEvent.data.item.status}</dd></>}</dl>{(selectedEvent.type === "item/delegation/progress" || selectedEvent.type === "item/delegation/completed") && <><p>Контекст делегирования без отдельного BB-треда недоступен.</p><button type="button" onClick={() => navigate.toThread(selectedEvent.threadId)}>Открыть исходный тред</button></>}</article>}
      {selectedAttempt && <article className="session-event-inspector"><h4>Попытка workflow</h4><p>{selectedAttempt.label}</p><dl>
        <dt>Индекс исполнителя</dt><dd>{selectedAttempt.index}</dd><dt>Попытка</dt><dd>{selectedAttempt.attempt}</dd>
        {selectedAttempt.phaseTitle && <><dt>Этап</dt><dd>{selectedAttempt.phaseTitle}{selectedAttempt.phaseIndex != null ? ` · ${selectedAttempt.phaseIndex}` : ""}</dd></>}
        <dt>Состояние</dt><dd>{formatWorkflowAttemptStatus(selectedAttempt.state)}</dd><dt>Модель</dt><dd>{selectedAttempt.model}</dd>
        {selectedAttempt.queuedAt != null && <><dt>В очереди</dt><dd>{new Date(selectedAttempt.queuedAt).toLocaleString("ru-RU")}</dd></>}
        {selectedAttempt.startedAt != null && <><dt>Запущен</dt><dd>{new Date(selectedAttempt.startedAt).toLocaleString("ru-RU")}</dd></>}
        <dt>Последнее обновление</dt><dd>{new Date(selectedAttempt.lastProgressAt).toLocaleString("ru-RU")}</dd>
        {selectedAttempt.durationMs != null && <><dt>Длительность</dt><dd>{Math.round(selectedAttempt.durationMs / 1000)} с</dd></>}
        {selectedAttempt.error && <><dt>Ошибка</dt><dd>{selectedAttempt.error}</dd></>}
        {selectedAttempt.resultPreview && <><dt>Результат</dt><dd>{selectedAttempt.resultPreview}</dd></>}
      </dl><p>SDK не публикует отдельный threadId у записи исполнителя; попытка относится к видимому исходному треду.</p><button type="button" onClick={() => navigate.toThread(selectedAttempt.sourceThreadId)}>Открыть исходный тред</button></article>}
    </section>
  </main>;
}

export function AgentsPanel(props: ExperimentalThreadTabProps) {
  return <AgentsContent key={JSON.stringify([props.threadId, props.environment?.id])} {...props} />;
}

function ContextSnapshot({ event }: { event: Extract<AgentEvent, { type: "thread/contextWindowUsage/updated" }> }) {
  const usage = event.data.contextWindowUsage;
  const snapshot = usage.snapshot;
  return <dl>
    <dt>Использовано</dt><dd>{formatTokenCount(usage.usedTokens)}</dd>
    <dt>Размер окна</dt><dd>{formatTokenCount(usage.modelContextWindow)}</dd>
    <dt>Снимок</dt><dd>{snapshot ? new Date(snapshot.capturedAt).toLocaleString("ru-RU") : new Date(event.createdAt).toLocaleString("ru-RU")}</dd>
    {usage.cost && <><dt>Стоимость снимка</dt><dd>{usage.cost.amount} {usage.cost.currency}{usage.estimated ? " · оценка провайдера" : ""}</dd></>}
    {snapshot?.categories && <><dt>Категории</dt><dd>{snapshot.categories.map((category) => `${category.label}: ${formatTokenCount(category.tokens)}${category.entries.length ? ` (${category.entries.map((entry) => `${entry.label}: ${formatTokenCount(entry.tokens)}`).join(", ")})` : ""}`).join(" · ")}</dd></>}
  </dl>;
}
