// Company model providers in Activity: one sentence per event, in a manager's words, from names only.
import type { EventRecord, EventType } from "@rosterdock/shared";
import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/lib/format.ts";
import { fixture } from "./fixtures.ts";

const daniel = { kind: "user" as const, id: fixture.members[0]!.userId };
const ev = (type: EventType, payload: Record<string, unknown>): EventRecord => ({
  id: "e",
  companyId: fixture.company.id,
  seq: 1,
  type,
  actor: daniel,
  subject: { kind: "model_provider", id: "p" },
  payload,
  createdAt: "2026-10-22T10:00:00.000Z",
});
const said = (type: EventType, payload: Record<string, unknown>) =>
  describeEvent(ev(type, payload), fixture).text;

describe("model provider events", () => {
  const acme = { name: "acme-azure", label: "Acme Azure", kind: "azure_openai" };

  it("says who added, changed, archived, brought back or removed which provider", () => {
    expect(said("model_provider.created", acme)).toBe("Daniel added the model provider Acme Azure");
    expect(said("model_provider.updated", { ...acme, changes: ["label", "models"] })).toBe(
      "Daniel changed the model provider Acme Azure",
    );
    expect(said("model_provider.updated", { ...acme, changes: ["enabled"], enabled: false })).toBe(
      "Daniel switched the model provider Acme Azure off",
    );
    expect(said("model_provider.archived", { ...acme, changes: ["archived"], archived: true })).toBe(
      "Daniel archived the model provider Acme Azure",
    );
    expect(said("model_provider.updated", { ...acme, changes: ["archived"], archived: false })).toBe(
      "Daniel brought back the model provider Acme Azure",
    );
    expect(said("model_provider.deleted", { ...acme })).toBe("Daniel removed the model provider Acme Azure");
    // A removal written before the label was carried names the provider by its name.
    expect(said("model_provider.deleted", { name: "acme-azure", kind: "azure_openai" })).toBe(
      "Daniel removed the model provider acme-azure",
    );
  });
});
