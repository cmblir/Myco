import { describe, expect, it } from "vitest";
import { WorkflowOperationError, workflowIssue, workflowStatus } from "./workflowOutcome";

describe("workflow completion truth", () => {
  it("keeps unavailable dependencies pending and retryable", () => {
    const issue = workflowIssue("validation", new WorkflowOperationError("pending", "unavailable", "synthetic validator offline"), "wiki/synthetic.md");
    expect(issue).toMatchObject({ step: "validation", item: "wiki/synthetic.md", status: "pending", code: "unavailable", retryable: true });
    expect(workflowStatus([issue], 0, 1)).toBe("pending");
  });

  it("keeps code failures failed and records partial committed work separately", () => {
    const issue = workflowIssue("digest", new Error("synthetic CAS conflict"));
    expect(workflowStatus([issue], 0, 1)).toBe("failed");
    expect(workflowStatus([issue], 3, 1)).toBe("partial");
    expect(issue.error).toContain("synthetic CAS conflict");
  });

  it("preserves string IPC cancellation and AbortError", () => {
    expect(workflowStatus([workflowIssue("ingest", "cancelled")], 1, 1)).toBe("stopped");
    const aborted = new Error("synthetic stop");
    aborted.name = "AbortError";
    expect(workflowIssue("ingest", aborted)).toMatchObject({ status: "stopped", code: "cancelled" });
    expect(workflowIssue("ingest", new Error("A file named cancelled.md is unreadable")).status).toBe("failed");
  });

  it("does not certify unfinished coverage as success", () => {
    expect(workflowStatus([], 0, 2)).toBe("pending");
    expect(workflowStatus([], 48, 2)).toBe("partial");
    expect(workflowStatus([], 48, 0)).toBe("success");
  });
});
