import { useEffect, useState } from "react";
import { experimental_useProviders, UrlLink, useSdk } from "@get-bb/plugin-sdk/app";
import { isQuotaStale, readMcpInventory, readProviderQuotas, readThreadTelemetry, remainingBudgetUsd, remainingQuota } from "./lib/session-telemetry.js";
import { moneyLabel, percentLabel, SessionMeter, SessionRow } from "./session-rows.js";

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

function QuotaSection({ quotas, telemetry, now, refresh, refreshing }: {
  quotas: Quotas | null | undefined; telemetry: Telemetry | null; now: number;
  refresh: () => void; refreshing: boolean;
}) {
  const { providers } = experimental_useProviders();
  const limits = telemetry?.limits;
  const cost = telemetry?.cost;
  return <section className="session-section" aria-label="Расход и баланс">
    <div className="session-heading">
      <h3>Расход и баланс</h3>
      <button type="button" onClick={refresh} disabled={refreshing} aria-label="Обновить квоты и баланс">{refreshing ? "Обновляю…" : "Обновить"}</button>
    </div>
    {quotas?.map(({ id, label, providerId, shared, measurement, source }) => {
      const sample = measurement?.usage.status === "ok" && measurement.observedAt !== null
        ? { windows: measurement.usage.windows, at: measurement.observedAt } : null;
      const providerName = providers.find(({ id }) => id === providerId)?.displayName ?? providerId;
      return <div className="session-usage-resource" key={id}>
        <SessionRow label={<strong>{providerName}</strong>}>
          <span title={source}>{shared ? "Общий аккаунт" : label}</span>
        </SessionRow>
        {sample?.windows.map((row) => {
          const remaining = remainingQuota(row.usedPercent);
          const stale = isQuotaStale(sample.at, row.resetsAt ? Date.parse(row.resetsAt) : null, now);
          const windowLabel = row.model ? `${row.label} · ${row.model}` : row.label;
          return <div className="session-usage-window" key={row.id}>
            <SessionRow label={windowLabel}>
              <span title={row.resetsAt ? `Сброс ${time(row.resetsAt)}` : undefined}>{percentLabel(remaining)} осталось</span>
            </SessionRow>
            <SessionMeter label={`Остаток квоты: ${windowLabel}`} percent={remaining} />
            {row.cost && <SessionRow label="Остаток бюджета">
              <span title={`Лимит ${moneyLabel(row.cost.limitUsdCents / 100, "USD")}`}>{moneyLabel(remainingBudgetUsd(row.cost), "USD")}</span>
            </SessionRow>}
            {stale && <small>Замер устарел</small>}
          </div>;
        })}
        {!sample?.windows.length && <SessionRow label="Квота">Нет данных</SessionRow>}
        {measurement?.observedAt != null && <small title={source}>Замер {time(measurement.observedAt)}</small>}
      </div>;
    })}
    {!quotas?.length && <SessionRow label="Квоты">{refreshing ? "Загрузка…" : "Нет данных"}</SessionRow>}
    {limits && <details>
      <summary>Лимиты этого треда <span>{limitStatus[limits.status]}</span></summary>
      <small>Замер {time(limits.at)}{isQuotaStale(limits.at, null, now) ? " · устарел" : ""}</small>
      {limits.windows.map((row, index) => <SessionRow key={row.providerKey ?? index} label={row.label ?? "Окно квоты"}>
        <span title={row.resetsAtMs !== null ? `Сброс ${time(row.resetsAtMs)}` : undefined}>{limitStatus[row.status]}</span>
      </SessionRow>)}
    </details>}
    {!quotas?.some(({ measurement }) => measurement?.usage.status === "ok" && measurement.observedAt !== null &&
      measurement.usage.windows.some((row) => row.cost)) && <SessionRow label="Денежный баланс">Нет данных</SessionRow>}
    <SessionRow label={<UrlLink href="/plugins/usage-page/usage">Стоимость сессии</UrlLink>}>
      {cost ? <span title={`Отчёт провайдера · ${time(cost.at)}`}>{moneyLabel(cost.amount, cost.currency)}{cost.estimated ? " · оценка" : ""}</span> : "Нет данных"}
    </SessionRow>
  </section>;
}

export function SessionTelemetry({ threadId, providerId, hostId, workspacePath }: {
  threadId: string; providerId: string; hostId: string | null; workspacePath: string | null;
}) {
  const sdk = useSdk();
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [quotas, setQuotas] = useState<Quotas | null | undefined>();
  const [quotaRefresh, setQuotaRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
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
    void readProviderQuotas(sdk, providerId, hostId, controller.signal, quotaRefresh > 0).then((rows) => {
      if (!controller.signal.aborted) setQuotas(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setQuotas(null);
    }).finally(() => {
      if (!controller.signal.aborted) { setRefreshing(false); setNow(Date.now()); }
    });
    return () => controller.abort();
  }, [sdk, providerId, hostId, quotaRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    void readMcpInventory(sdk, providerId, hostId, workspacePath, controller.signal).catch(() => null).then((snapshot) => {
      if (!controller.signal.aborted) setInventory(snapshot);
    });
    return () => controller.abort();
  }, [sdk, providerId, hostId, workspacePath]);

  return <>
    <QuotaSection telemetry={telemetry} quotas={quotas} now={now} refreshing={refreshing} refresh={() => {
      setRefreshing(true);
      setQuotaRefresh((value) => value + 1);
    }} />
    <section className="session-section" aria-label="MCP">
      <details open={!!inventory?.servers.length}>
      <summary>MCP <span>{inventory ? `${inventory.servers.filter((server) => server.state === "configured").length}/${inventory.servers.length}` : "Нет данных"}</span></summary>
      {inventory ? <>
        <small>Конфигурация MCP Manager{inventory.truncated ? " · снимок неполный" : ""}</small>
        {inventory.servers.length
          ? inventory.servers.map((server) => <SessionRow key={server.id} label={<><i aria-hidden="true" className={`session-dot is-${server.state}`} />{server.name}</>}>{configurationLabels[server.state]}</SessionRow>)
          : <p>Для провайдера нет записей в инвентаре машины.</p>}
      </> : <p>{inventory === undefined ? "Загрузка конфигурации…" : "Подтверждённая конфигурация машины недоступна."}</p>}
      {!!telemetry?.tools?.length && <h4>Недавние вызовы в треде</h4>}
      {telemetry?.tools?.length ? <ul>{telemetry.tools.map(({ server, tool, status, at }) => <li key={JSON.stringify([server, tool])}>
        {server} · {tool} · {toolStatus[status] ?? status} · {time(at)}
      </li>)}</ul> : <p>{telemetry?.tools ? "В последних событиях нет вызовов MCP." : "События вызовов MCP пока недоступны."}</p>}
      <UrlLink href="/plugins/mcp-manager/inventory">Открыть инвентарь MCP</UrlLink>
      </details>
    </section>
  </>;
}
