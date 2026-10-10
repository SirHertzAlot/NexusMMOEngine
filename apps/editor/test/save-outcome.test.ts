import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IssuesError } from "../src/api.js";
import { describeSaveFailure, issueCount } from "../src/save-outcome.js";

class DocError extends IssuesError<{ path: string }> {}

describe("save outcome", () => {
  it("counts issues", () => {
    assert.equal(issueCount(1), "1 issue");
    assert.equal(issueCount(3), "3 issues");
  });

  it("a refused document keeps its issues and says how many", () => {
    const f = describeSaveFailure(new DocError([{ path: "a" }, { path: "b" }], "refused"));
    assert.deepEqual(f.status, { tone: "bad", text: "Not saved: 2 issues." });
    assert.equal(f.issues?.length, 2);
  });

  it("the panel can word the refusal", () => {
    const f = describeSaveFailure(new DocError([{ path: "a" }], "x"), (i: Array<{ path: string }>) => `${i[0].path} is wrong`);
    assert.equal(f.status?.text, "a is wrong");
    assert.equal(describeSaveFailure(new DocError([{ path: "a" }], "x"), () => null).status, null);
  });

  it("any other failure is its own message and has no issues", () => {
    assert.deepEqual(describeSaveFailure(new Error("disk full")), { status: { tone: "bad", text: "disk full" }, issues: null });
    assert.equal(describeSaveFailure("boom").status?.text, "boom");
  });
});
