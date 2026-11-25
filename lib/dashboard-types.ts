/** Shared read models for the projects dashboard. */

export interface DashboardThread {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  displayStatus: string | null;
  parentThreadId: string | null;
  updatedAt: number;
  environmentId: string | null;
  providerId: string;
}

export interface GitEnvironment {
  projectId: string;
  id: string;
  name: string | null;
  isWorktree: boolean;
  branchName: string | null;
  outcome: "available" | "not_applicable" | "unavailable" | "error";
  branch: string | null;
  changedFiles: number | null;
  hasUncommittedChanges: boolean | null;
}
