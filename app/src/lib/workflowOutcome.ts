/** Completion truth shared by headless and interactive wiki workflows. */
import type { Strings } from "./i18n";

export type WorkflowStatus = "success" | "partial" | "failed" | "stopped" | "skipped" | "pending";

/** Titles describe incomplete work independently of legacy UI stages. */
export function workflowLabel(status: WorkflowStatus, strings: Strings): string {
  return status === "pending" ? strings.workflow_pending
    : status === "partial" ? strings.workflow_partial
    : status === "stopped" ? strings.workflow_stopped
    : status === "failed" ? strings.workflow_failed
    : status === "skipped" ? strings.workflow_skipped : strings.ing_success_title;
}

export interface WorkflowIssue {
  step: string;
  item?: string;
  status: "failed" | "stopped" | "pending";
  code: "operation_failed" | "unavailable" | "cancelled" | "incomplete" | "model_missing" | "validation_rejected" | "ipc_failed" | "no_exact_excerpt";
  error: string;
  retryable: boolean;
}

export interface WorkflowProgress {
  status?: WorkflowStatus;
  issues?: WorkflowIssue[];
}

export interface WorkflowStep extends WorkflowProgress {
  step: string;
  status: WorkflowStatus;
}

export interface WorkflowReceipt {
  status: WorkflowStatus;
  steps: WorkflowStep[];
  issues: WorkflowIssue[];
}

/** An unavailable dependency is pending, rather than a validated success. */
export class WorkflowOperationError extends Error {
  constructor(
    readonly status: WorkflowIssue["status"],
    readonly code: WorkflowIssue["code"],
    message: string,
  ) {
    super(message);
    this.name = "WorkflowOperationError";
  }
}

export function workflowIssue(step: string, error: unknown, item?: string): WorkflowIssue {
  const message = error instanceof Error ? error.message : String(error);
  const stopped = error instanceof Error && error.name === "AbortError" || /^(stopped|cancelled|canceled)$/i.test(message);
  return {
    step,
    ...(item ? { item } : {}),
    status: error instanceof WorkflowOperationError ? error.status : stopped ? "stopped" : "failed",
    code: error instanceof WorkflowOperationError ? error.code : stopped ? "cancelled" : "operation_failed",
    error: String(error),
    retryable: true,
  };
}

/** Preserve the cause of an incomplete run and whether any work was committed. */
export function workflowStatus(issues: WorkflowIssue[], completed: number, pending: number): WorkflowStatus {
  if (issues.some(issue => issue.status === "stopped")) return "stopped";
  if (issues.length) return completed > 0 ? "partial" : issues.some(issue => issue.status === "failed") ? "failed" : "pending";
  return pending > 0 ? completed > 0 ? "partial" : "pending" : "success";
}
