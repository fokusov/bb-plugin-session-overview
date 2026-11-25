/**
 * Project card selection, filters and sorting.
 *
 * BB project rows have no archive flag in Plugin SDK 0.6.157, so the default
 * view keeps projects with work in the last 30 days or a pin, and the user can
 * switch to every registered project. Sorting never invents a value: a card
 * with no cost data sorts after cards with known cost.
 */

export type ProjectSort = "activity" | "blockers" | "cost" | "name";

export interface ProjectCard {
  id: string;
  name: string;
  kind: "personal" | "standard";
  pinned: boolean;
  /** Newest visible thread update, or null when the project has no threads. */
  lastActivityAt: number | null;
  activeThreads: number;
  blockers: number | null;
  tokens: number | null;
}

export interface CardQuery {
  query: string;
  showAll: boolean;
  sort: ProjectSort;
  now?: number;
  days?: number;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("ru-RU");
}

export function isDefaultVisible(card: ProjectCard, now = Date.now(), days = 30): boolean {
  if (card.pinned) return true;
  if (card.activeThreads > 0) return true;
  if (card.lastActivityAt === null) return false;
  return card.lastActivityAt >= now - days * 24 * 60 * 60 * 1000;
}

function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function selectProjectCards(cards: readonly ProjectCard[], query: CardQuery): ProjectCard[] {
  const needle = normalized(query.query);
  const filtered = cards.filter((card) => {
    if (!query.showAll && !isDefaultVisible(card, query.now, query.days)) return false;
    if (!needle) return true;
    return normalized(card.name).includes(needle);
  });
  return filtered.slice().sort((a, b) => {
    switch (query.sort) {
      case "blockers":
        return compareNullable(a.blockers, b.blockers) || compareNullable(a.lastActivityAt, b.lastActivityAt);
      case "cost":
        return compareNullable(a.tokens, b.tokens) || compareNullable(a.lastActivityAt, b.lastActivityAt);
      case "name":
        return a.name.localeCompare(b.name, "ru-RU");
      case "activity":
      default:
        return compareNullable(a.lastActivityAt, b.lastActivityAt) || a.name.localeCompare(b.name, "ru-RU");
    }
  });
}

export function togglePinned(pinned: readonly string[], projectId: string): string[] {
  return pinned.includes(projectId) ? pinned.filter((id) => id !== projectId) : [...pinned, projectId];
}

/** A worktree choice stays inside the project and falls back to the default source. */
export function resolveSelectedEnvironment<T extends { id: string; projectId: string }>(
  environments: readonly T[],
  selectedId: string | null,
): T | null {
  if (!selectedId) return null;
  return environments.find((environment) => environment.id === selectedId) ?? null;
}

export interface SourceCounters {
  trackedFiles: number;
  trackedBytes: number;
  complete: boolean;
  reason: string | null;
  byExtension: Array<{ extension: string; bytes: number }>;
}

export function summarizeSourceCounters(metrics: {
  trackedFiles: number;
  trackedBytes: number;
  complete: boolean;
  reason: string | null;
  byExtension: Readonly<Record<string, number>>;
}): SourceCounters {
  return {
    trackedFiles: metrics.trackedFiles,
    trackedBytes: metrics.trackedBytes,
    complete: metrics.complete,
    reason: metrics.reason,
    byExtension: Object.entries(metrics.byExtension)
      .map(([extension, bytes]) => ({ extension, bytes }))
      .sort((a, b) => b.bytes - a.bytes || a.extension.localeCompare(b.extension)),
  };
}

export function relativeTime(at: number | null, now = Date.now()): string {
  if (at === null) return "нет активности";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return new Date(at).toLocaleDateString("ru-RU");
}
