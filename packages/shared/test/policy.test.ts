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

  it("classifies a tool as a write unless the catalog or its name says read", () => {
    expect(classifyTool("create_contact")).toEqual({ write: true, source: "default" });
    expect(classifyTool("get_contact")).toEqual({ write: false, source: "name" });
    expect(classifyTool("list-workflows")).toEqual({ write: false, source: "name" });
    expect(classifyTool("hubspot.search_companies")).toEqual({ write: false, source: "name" });
    expect(classifyTool("getter_upper")).toEqual({ write: true, source: "default" });
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

  it("a server's read-only label makes a read only with a second sign: a name that reads, or the catalog's list", () => {
    const readOnly = { readOnlyHint: true };
    // With a second sign the label holds: the name reads, or the connector's catalog lists the tool as a read.
    expect(classifyTool("search_crm_objects", { annotations: readOnly })).toEqual({
      write: false,
      source: "annotation",
    });
    expect(classifyTool("github.list_branches", { annotations: readOnly })).toEqual({
      write: false,
      source: "annotation",
    });
    expect(
      classifyTool("slack_read_channel", {
        annotations: readOnly,
        catalog: { reads: ["slack_read_channel"], writes: ["slack_send_message"] },
      }),
    ).toEqual({ write: false, source: "annotation" });
    // Without one the tool is a write, held for a person to confirm. GitHub's server labels these read-only.
    for (const name of ["issue_read", "pull_request_read", "github.issue_read", "whoami", "run_query"])
      expect(classifyTool(name, { annotations: readOnly }), name).toEqual({
        write: true,
        source: "unconfirmed",
      });
    expect(
      classifyTool("issue_read", { annotations: readOnly, catalog: { reads: ["get_issue"], writes: [] } }),
    ).toEqual({ write: true, source: "unconfirmed" });
    // A name that joins a second verb is no second sign.
    expect(classifyTool("get_or_create_label", { annotations: readOnly })).toEqual({
      write: true,
      source: "unconfirmed",
    });
    // The catalog's list of writes beats the label, whatever the name says.
    expect(
      classifyTool("create_issue", {
        annotations: readOnly,
        catalog: { reads: [], writes: ["create_issue"] },
      }),
    ).toEqual({ write: true, source: "catalog" });
    expect(
      classifyTool("get_token", { annotations: readOnly, catalog: { reads: [], writes: ["get_token"] } }),
    ).toEqual({ write: true, source: "catalog" });
  });

  it("a server's word that a tool writes or destroys makes a write, over the catalog and the name", () => {
    const listed = { reads: ["get_contact"], writes: [] };
    expect(classifyTool("get_contact", { annotations: { readOnlyHint: false }, catalog: listed })).toEqual({
      write: true,
      source: "annotation",
    });
    expect(classifyTool("get_contact", { annotations: { destructiveHint: true }, catalog: listed })).toEqual({
      write: true,
      source: "annotation",
    });
    // A tool labelled read-only and destructive at once is taken at its worse word.
    expect(
      classifyTool("get_contact", { annotations: { readOnlyHint: true, destructiveHint: true } }),
    ).toEqual({ write: true, source: "annotation" });
    // Not destructive says nothing about reading: the rest of the rule decides.
    expect(classifyTool("get_contact", { annotations: { destructiveHint: false } })).toEqual({
      write: false,
      source: "name",
    });
    expect(classifyTool("archive_contact", { annotations: { destructiveHint: false } })).toEqual({
      write: true,
      source: "default",
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
