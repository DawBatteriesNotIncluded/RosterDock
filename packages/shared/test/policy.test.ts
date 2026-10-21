import { describe, expect, it } from "vitest";
import {
  classifyTool,
  effectiveMode,
  narrowerMode,
  readsByName,
  toolGranted,
  verdictFor,
} from "../src/index.js";

describe("tool policy", () => {
  it("a toolbox line grants every tool unless it names some; then only those", () => {
    expect(toolGranted({ connection: "hubspot", mode: "read" }, "search_crm_objects")).toBe(true);
    expect(toolGranted({ connection: "hubspot", mode: "read", tools: null }, "search_crm_objects")).toBe(
      true,
    );
    const some = { connection: "hubspot", mode: "read" as const, tools: ["search_crm_objects"] };
    expect(toolGranted(some, "search_crm_objects")).toBe(true);
    expect(toolGranted(some, "get_properties")).toBe(false);
    expect(toolGranted({ connection: "hubspot", mode: "read", tools: [] }, "search_crm_objects")).toBe(false);
    expect(toolGranted(undefined, "search_crm_objects")).toBe(false);
  });

  it("a connection not in the toolbox is off, whatever the department or client say", () => {
    const d = effectiveMode({ toolbox: [], connection: "hubspot", departmentWritePolicy: "ask" });
    expect(d).toEqual({ mode: "off", narrowedBy: ["toolbox"] });
  });

  it("the toolbox is the ceiling; a readonly department caps writes away; the client caps again", () => {
    const toolbox = [{ connection: "hubspot", mode: "ask" as const }];
    expect(effectiveMode({ toolbox, connection: "hubspot", departmentWritePolicy: "ask" })).toEqual({
      mode: "ask",
      narrowedBy: [],
    });
    expect(effectiveMode({ toolbox, connection: "hubspot", departmentWritePolicy: "drafts" }).mode).toBe(
      "ask",
    );
    expect(effectiveMode({ toolbox, connection: "hubspot", departmentWritePolicy: "readonly" })).toEqual({
      mode: "read",
      narrowedBy: ["department"],
    });
    expect(
      effectiveMode({
        toolbox,
        connection: "hubspot",
        departmentWritePolicy: "ask",
        clientPolicy: { caps: { hubspot: "read" } },
      }),
    ).toEqual({ mode: "read", narrowedBy: ["client"] });
    expect(
      effectiveMode({
        toolbox,
        connection: "hubspot",
        clientPolicy: { default: "off", caps: { slack: "ask" } },
      }),
    ).toEqual({ mode: "off", narrowedBy: ["client"] });
    // A policy can never widen: a client cap of ask over a read grant stays read.
    expect(
      effectiveMode({
        toolbox: [{ connection: "hubspot", mode: "read" }],
        connection: "hubspot",
        clientPolicy: { caps: { hubspot: "ask" } },
      }).mode,
    ).toBe("read");
    expect(narrowerMode("ask", "read")).toBe("read");
    expect(narrowerMode("off", "ask")).toBe("off");
  });

  it("verdicts: reads run unless off; writes propose under ask and are refused under read", () => {
    expect(verdictFor("off", false)).toBe("refuse");
    expect(verdictFor("read", false)).toBe("run");
    expect(verdictFor("read", true)).toBe("refuse");
    expect(verdictFor("ask", false)).toBe("run");
    expect(verdictFor("ask", true)).toBe("propose");
  });

  it("classifies a tool as a write unless an annotation, the catalog or its name says read", () => {
    expect(classifyTool("create_contact")).toEqual({ write: true, source: "default" });
    expect(classifyTool("get_contact")).toEqual({ write: false, source: "name" });
    expect(classifyTool("list-workflows")).toEqual({ write: false, source: "name" });
    expect(classifyTool("hubspot.search_companies")).toEqual({ write: false, source: "name" });
    expect(classifyTool("getter_upper")).toEqual({ write: true, source: "default" });
    expect(classifyTool("run_query", { annotations: { readOnlyHint: true } })).toEqual({
      write: false,
      source: "annotation",
    });
    expect(classifyTool("get_and_delete", { annotations: { readOnlyHint: false } })).toEqual({
      write: true,
      source: "annotation",
    });
    expect(classifyTool("execute_workflow", { catalog: { reads: ["execute_workflow"] } })).toEqual({
      write: false,
      source: "catalog",
    });
    expect(classifyTool("get_token", { catalog: { writes: ["get_token"] } })).toEqual({
      write: true,
      source: "catalog",
    });
  });

  it("a name reads only with a reading verb first and no second verb joined to it", () => {
    // An export sends data somewhere or starts a job; a preview is often built or sent; check_in, check_out
    // and a check run change state. None of them is a reading verb.
    for (const name of [
      "export_contacts",
      "hubspot.export_contacts",
      "export-report",
      "preview_campaign",
      "check_in",
      "checkout",
      "get_or_create_contact",
      "find_and_replace",
      "read-then-archive",
      "list_and_delete_drafts",
    ])
      expect(classifyTool(name), name).toEqual({ write: true, source: "default" });
    for (const name of [
      "summarize_thread",
      "lookup_owner",
      "look_up_owner",
      "browse_catalog",
      "inspect_execution",
      "count_deals",
      "get_order_history",
      "list_vendors",
      "search_android",
    ])
      expect(classifyTool(name), name).toEqual({ write: false, source: "name" });
    expect(readsByName("slack:read_channel")).toBe(true);
    expect(readsByName("slack:export_channel")).toBe(false);
  });
});
