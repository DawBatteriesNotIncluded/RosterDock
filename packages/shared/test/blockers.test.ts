import { describe, expect, it } from "vitest";
import { BLOCKER_CODES, blockerFor, blockerKind, isBlockerCode } from "../src/index.js";

describe("blocker taxonomy", () => {
  it("has manager-readable defaults for every code", () => {
    for (const code of BLOCKER_CODES) {
      const b = blockerFor(code);
      expect(b.code).toBe(code);
      expect(b.what.length).toBeGreaterThan(10);
      expect(b.why.length).toBeGreaterThan(10);
      expect(typeof b.retrySafe).toBe("boolean");
    }
  });

  it("dropped the governance ladder codes", () => {
    expect(isBlockerCode("kill_switch")).toBe(false);
    expect(isBlockerCode("governance_level")).toBe(false);
    expect(isBlockerCode("waiting_on_teammate")).toBe(true);
  });

  it("merges overrides without losing defaults", () => {
    const b = blockerFor("waiting_on_teammate", {
      what: "Cody is waiting on Brody for the comparison criteria.",
      waitingOn: { kind: "teammate", id: "t-brody", name: "Brody" },
    });
    expect(b.what).toMatch(/Brody/);
    expect(b.why).toBe(blockerFor("waiting_on_teammate").why);
    expect(b.waitingOn?.name).toBe("Brody");
    expect(b.retrySafe).toBe(true);
  });

  it("maps codes onto the Blocked column's reasons", () => {
    expect(blockerKind("dependencies_unresolved")).toBe("dependency");
    expect(blockerKind("waiting_on_teammate")).toBe("teammate");
    expect(blockerKind("waiting_on_person")).toBe("person");
    expect(blockerKind("approval_required")).toBe("approval");
    expect(blockerKind("approval_rejected")).toBe("approval");
    expect(blockerKind("timeout")).toBe("run");
    expect(blockerKind("unknown")).toBe("run");
  });

  it("marks approval and evidence blockers as not retry-safe", () => {
    expect(blockerFor("approval_required").retrySafe).toBe(false);
    expect(blockerFor("approval_required").resumeInstructions).toMatch(/do not start the task again/);
    expect(blockerFor("evidence_failed").retrySafe).toBe(false);
  });
});
