import { useEffect, useState } from "react";
import { UrlLink, useSdk } from "@get-bb/plugin-sdk/app";
import { isQuotaStale, readMcpInventory, readProviderQuotas, readThreadTelemetry, remainingQuota } from "./lib/session-telemetry.js";

type Quotas = Awaited<ReturnType<typeof readProviderQuotas>>;
type Telemetry = Awaited<ReturnType<typeof readThreadTelemetry>>;
type McpInventory = Awaited<ReturnType<typeof readMcpInventory>>;
const toolStatus: Record<string, string> = {
  completed: "завершён", failed: "ошибка вызова", interrupted: "прерван", pending: "начат",
};
const limitStatus: Record<string, string> = {
  allowed: "доступно", blocked: "исчерпано", warning: "порог предупреждения", unknown: "неизвестно",
};
const configurationLabels = { configured: "настроен", disabled: "отключён", invalid: "ошибка конфигурации" };

function time(value: number | string): string {
  return new Date(value).toLocaleString();
}

function QuotaSection({ quotas, telemetry, now }: { quotas: Quotas | null | undefined; telemetry: Telemetry | null; now: number }) {
  const limits = telemetry?.limits;
  const cost = telemetry?.cost;
  return <section className="session-section" aria-label="Квоты и стоимость">
    <h3>Квоты и стоимость</h3>
    {limits && <>
      <p>Эта сессия: {limitStatus[limits.status]} · {time(limits.at)}{isQuotaStale(limits.at, null, now) ? " · замер устарел" : ""}</p>
      {limits.windows.length > 0 && <ul>{limits.windows.map((row, index) => <li key={row.providerKey ?? index}>
        {row.label ?? "Окно квоты"} · {limitStatus[row.status]}
        {row.resetsAtMs !== null ? ` · сброс ${time(row.resetsAtMs)}` : ""}
        {isQuotaStale(limits.at, row.resetsAtMs, now) ? " · замер устарел" : ""}
      </li>)}</ul>}
    </>}
    {quotas?.map(({ id, label, measurement, source }) => <div key={id}>
      <p>{label} · квота ресурса на машине · {source}</p>
      {measurement?.usage.status === "ok" && measurement.observedAt !== null ? <>
        <small>Замер {time(measurement.observedAt)}</small>
        <ul>{measurement.usage.windows.map((row) => <li key={row.id}>
          {row.label}{row.model ? ` · ${row.model}` : ""} · остаток {remainingQuota(row.usedPercent).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
          {row.resetsAt ? ` · сброс ${time(row.resetsAt)}` : ""}
          {isQuotaStale(measurement.observedAt, row.resetsAt ? Date.parse(row.resetsAt) : null, now) ? " · замер устарел" : ""}
        </li>)}</ul>
      </> : <p>Замер ресурса недоступен.</p>}
    </div>)}
    {!limits && !quotas?.length && <p>{quotas === undefined ? "Загрузка квот…" : "Данные о квотах недоступны."}</p>}
    {cost
      ? <p>Стоимость по отчёту провайдера: {cost.amount} {cost.currency}{cost.estimated ? " · оценка" : ""} · {time(cost.at)}</p>
      : <p>Стоимость сессии недоступна.</p>}
    <UrlLink href="/plugins/usage-page/usage">История расходов в Usage</UrlLink>
  </section>;
}

export function SessionTelemetry({ threadId, providerId, hostId, workspacePath }: {
  threadId: string; providerId: string; hostId: string | null; workspacePath: string | null;
}) {
  const sdk = useSdk();
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [quotas, setQuotas] = useState<Quotas | null | undefined>();
  const [inventory, setInventory] = useState<McpInventory | undefined>();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const snapshot = await readThreadTelemetry(sdk, threadId, providerId, signal);
        if (!signal.aborted) setTelemetry(snapshot);
      } catch {
        if (!signal.aborted) setTelemetry(null);
      }
      if (!signal.aborted) {
        setNow(Date.now());
        timer = setTimeout(() => void load(), 15_000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sdk, providerId, threadId]);

  useEffect(() => {
    const controller = new AbortController();
    void readProviderQuotas(sdk, providerId, hostId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setQuotas(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setQuotas(null);
    });
    return () => controller.abort();
  }, [sdk, providerId, hostId]);

  useEffect(() => {
    const controller = new AbortController();
    void readMcpInventory(sdk, providerId, hostId, workspacePath, controller.signal).catch(() => null).then((snapshot) => {
      if (!controller.signal.aborted) setInventory(snapshot);
    });
    return () => controller.abort();
  }, [sdk, providerId, hostId, workspacePath]);

  return <>
    <section className="session-section" aria-label="MCP">
      <h3>MCP</h3>
      {inventory ? <>
        <small>Конфигурация MCP Manager · {time(inventory.scannedAt)}{inventory.truncated ? " · снимок неполный" : ""}</small>
        {inventory.servers.length
          ? <ul>{inventory.servers.map((server) => <li key={server.id}>{server.name} · {configurationLabels[server.state]}</li>)}</ul>
          : <p>Для провайдера нет записей в инвентаре машины.</p>}
      </> : <p>{inventory === undefined ? "Загрузка конфигурации…" : "Подтверждённая конфигурация машины недоступна."}</p>}
      {!!telemetry?.tools?.length && <h4>Недавние вызовы в треде</h4>}
      {telemetry?.tools?.length ? <ul>{telemetry.tools.map(({ server, tool, status, at }) => <li key={JSON.stringify([server, tool])}>
        {server} · {tool} · {toolStatus[status] ?? status} · {time(at)}
      </li>)}</ul> : <p>{telemetry?.tools ? "В последних событиях нет вызовов MCP." : "События вызовов MCP пока недоступны."}</p>}
      <p>Текущий список инструментов и состояние подключений сессии недоступны.</p>
      <UrlLink href="/plugins/mcp-manager/inventory">Открыть инвентарь MCP</UrlLink>
    </section>
    <QuotaSection telemetry={telemetry} quotas={quotas} now={now} />
  </>;
}
