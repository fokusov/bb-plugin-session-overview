/**
 * Project-scoped thread forest for the card's thread list.
 *
 * Rows are the visible threads BB returned for the project. A thread whose
 * parent is outside that visible set becomes a root instead of disappearing,
 * so a filtered or archived parent never hides a live child.
 */

export interface ProjectThreadRow {
  id: string;
  parentThreadId: string | null;
  title: string | null;
  titleFallback: string | null;
  status: string;
  displayStatus: string | null;
  updatedAt: number;
  environmentId: string | null;
  taskLabel: string | null;
}

export interface ProjectThreadNode extends ProjectThreadRow {
  children: ProjectThreadNode[];
}

export function threadTitle(row: Pick<ProjectThreadRow, "id" | "title" | "titleFallback">): string {
  return row.title || row.titleFallback || `Тред ${row.id.slice(0, 8)}`;
}

export function buildProjectThreadForest(rows: readonly ProjectThreadRow[]): ProjectThreadNode[] {
  const byId = new Map<string, ProjectThreadNode>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });
  const roots: ProjectThreadNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentThreadId ? byId.get(node.parentThreadId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: ProjectThreadNode[]) => {
    nodes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

export interface FlatThreadRow {
  node: ProjectThreadNode;
  depth: number;
}

export function flattenThreadForest(roots: readonly ProjectThreadNode[]): FlatThreadRow[] {
  const rows: FlatThreadRow[] = [];
  const visit = (node: ProjectThreadNode, depth: number) => {
    rows.push({ node, depth });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}
