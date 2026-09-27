import { describe, expect, it } from "vitest";
import {
  AgentStatusSchema,
  ConversationHistorySchema,
  DbQueryRequestSchema,
  DbQueryResultSchema,
  DeploymentStatusResultSchema,
  FileTreeSchema,
  FileWriteRequestSchema,
  FileWriteResultSchema,
  GithubStatusSchema,
  FigmaStatusSchema,
  ProjectLaunchResultSchema,
  RebuildStatusResultSchema,
  TablesStructureResultSchema,
  UpstreamEnvelopeSchema,
  VcaasProjectSchema,
  VcaasProjectSummarySchema,
  VersionsListSchema,
  upstreamEnvelopeSchema,
  vcaasResponseSchema,
  QueryOptionsSchema,
} from "../src/v1";

const project = {
  projectId: "velas-artesanas",
  label: "Velas artesanas",
  description: "Una tienda de velas artesanales",
  plan: "self-hosted",
  agentProcessStatus: "done",
  agentServerStatus: "Active",
  createdAt: "2026-09-25T10:00:00.000Z",
  deployment: { status: "success", createdAt: "2026-09-25T11:00:00.000Z", versionId: "v_01" },
  versionRecovery: null,
  importInProgress: null,
  secrets: [{ _id: "s1", secretName: "STRIPE_SECRET_KEY", environment: "both" }],
  customDomain: {
    hostname: "velas.example.com",
    status: "pending_validation",
    sslStatus: "initializing",
    dnsRecordsToAdd: [{ type: "CNAME", name: "velas", value: "velas-artesanas.apps.example.com" }],
    createdAt: "2026-09-25T12:00:00.000Z",
  },
  temporalDevelopmentProjectUrl: "https://velas-artesanas.dev.example.com",
  cachedDevelopmentUrl: null,
  developmentUrlFieldToUse: "temporalDevelopmentProjectUrl",
  productionProjectUrl: "velas-artesanas.apps.example.com",
  previewImageUrl: "https://forja.example.com/api/files/tok",
};

describe("project shapes", () => {
  it("round-trips a full project", () => {
    expect(VcaasProjectSchema.parse(project)).toEqual(project);
  });

  it("accepts a minimal fresh project", () => {
    const minimal = { projectId: "my-app", description: "", plan: "self-hosted", createdAt: "x", secrets: [] };
    expect(VcaasProjectSchema.parse(minimal)).toEqual(minimal);
  });

  it("keeps unknown domain statuses (open enum)", () => {
    const p = { ...project, customDomain: { ...project.customDomain, status: "moved", sslStatus: "new_state" } };
    expect(VcaasProjectSchema.parse(p).customDomain?.status).toBe("moved");
  });

  it("rejects an unknown server status", () => {
    expect(VcaasProjectSchema.safeParse({ ...project, agentServerStatus: "Sleeping" }).success).toBe(false);
  });

  it("round-trips a summary and a launch result", () => {
    const summary = {
      projectId: "crm-app",
      description: "CRM",
      plan: "self-hosted",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastModifiedAt: "2026-09-02T00:00:00.000Z",
      previewImageUrl: null,
    };
    expect(VcaasProjectSummarySchema.parse(summary)).toEqual(summary);
    const launch = {
      projectId: "crm-app-2",
      requestedProjectId: "crm-app",
      agent: { started: true, status: "init" },
      warnings: [{ step: "figma", message: "Token rejected" }],
    };
    expect(ProjectLaunchResultSchema.parse(launch)).toEqual(launch);
  });
});

describe("conversation shapes", () => {
  const finished = {
    author: "agent",
    message: "Your shop is ready. **Try** the [home page](/).",
    messageType: "finished",
    createdAt: "2026-09-25T10:05:00.123456Z",
    versionId: "v_02",
    secretKeysNeeded: { STRIPE_SECRET_KEY: { isProvided: false, description: "Payments" } },
  };

  it("round-trips agent status with realtime messages", () => {
    const status = {
      projectId: "velas-artesanas",
      status: "init",
      startedAt: "2026-09-25T10:00:00.000Z",
      realtimeConversation: [
        { author: "agent", message: "Analysing your request…", messageType: "starting", createdAt: "a" },
        { author: "agent", message: "Building the home page", messageType: "building", createdAt: "b" },
      ],
      expectedMinutes: 8,
      expectedFinishAt: "2026-09-25T10:08:00.000Z",
    };
    expect(AgentStatusSchema.parse(status)).toEqual(status);
    expect(AgentStatusSchema.safeParse({ ...status, status: "error" }).success).toBe(false);
  });

  it("round-trips a history with user files", () => {
    const history = {
      conversation: [
        {
          author: "user",
          message: "Una tienda de velas",
          messageType: "regular",
          createdAt: "2026-09-25T10:00:00.000001Z",
          files: [{ name: "logo.png", url: "https://x/logo.png", imageDescription: "" }],
        },
        finished,
      ],
    };
    expect(ConversationHistorySchema.parse(history)).toEqual(history);
  });
});

describe("operations, files, versions, integrations", () => {
  it("round-trips representative payloads", () => {
    const cases: Array<[{ parse: (v: unknown) => unknown }, unknown]> = [
      [DeploymentStatusResultSchema, { status: null }],
      [DeploymentStatusResultSchema, { status: "deploying", createdAt: "t" }],
      [RebuildStatusResultSchema, { status: "error", errorMessage: "build failed" }],
      [
        FileTreeSchema,
        {
          entries: [
            { path: "src", name: "src", type: "folder", depth: 0 },
            { path: "src/app/page.tsx", name: "page.tsx", type: "file", size: 812, depth: 2 },
          ],
          totalEntries: 2,
          offset: 0,
          limit: 5000,
          hasMore: false,
          commitSha: "abc123",
          filesCount: 1,
        },
      ],
      [FileWriteRequestSchema, { path: "src/app/page.tsx", content: "PGRpdj4=", encoding: "base64" }],
      [FileWriteResultSchema, { path: "src/app/page.tsx", bytesWritten: 5, created: false, rebuildRequired: true }],
      [VersionsListSchema, { versions: [{ _id: "v1", name: "Initial", commitSha: "abc", createdAt: "t" }], totalCount: 1 }],
      [GithubStatusSchema, { connected: false, tokenValid: false, tokenExpired: false }],
      [FigmaStatusSchema, { connected: false }],
    ];
    for (const [schema, value] of cases) expect(schema.parse(value)).toEqual(value);
  });

  it("refuses a utf8 write (writes are always base64)", () => {
    expect(FileWriteRequestSchema.safeParse({ path: "a", content: "x", encoding: "utf8" }).success).toBe(false);
  });
});

describe("database CMS", () => {
  it("round-trips a table structure with a shared relation id", () => {
    const tables = {
      tables: [
        {
          _id: "order",
          type: "order",
          label: "Orders",
          description: "",
          icon: "table",
          properties: {
            customer_id: {
              id: "rel_1",
              name: "customer_id",
              propertyType: "objectReference",
              label: "Customer",
              objectReference: { objectReferenceTypeId: "customer", objectReferenceRelation: "manyToOne" },
            },
            status: {
              id: "p2",
              name: "status",
              propertyType: "options",
              label: "Status",
              typeExtras: { options: [{ id: "new", value: "new" }] },
            },
          },
        },
      ],
    };
    expect(TablesStructureResultSchema.parse(tables)).toEqual(tables);
  });

  it("accepts the UI's query DSL, including relation filters and expansions", () => {
    const request = {
      tableName: "order",
      queryOptions: {
        _limit: 25,
        _offset: 0,
        _sort: { createdAt: "desc" },
        _count: true,
        _filter: {
          status: { in: ["new", "paid"] },
          total: { gte: 10 },
          notes: { in: [null, ""] },
          _or: [{ name: { regex: "vela", options: "i" } }, { sku: { startsWith: "V-" } }],
          customer: { _has: "some", _filter: { email: { endsWith: "@example.com" } } },
        },
        customer: true,
        items: { _limit: 5 },
      },
    };
    expect(DbQueryRequestSchema.parse(request)).toEqual(request);
  });

  it("rejects a malformed expansion and unknown operators", () => {
    expect(QueryOptionsSchema.safeParse({ items: "yes" }).success).toBe(false);
    expect(QueryOptionsSchema.safeParse({ _filter: { a: { like: "%x%" } } }).success).toBe(false);
  });

  it("reads the total from the first row", () => {
    const result = DbQueryResultSchema.parse({ results: [{ _id: "a1", name: "x", _count: { _total: 42 } }] });
    expect(result.results[0]?._count?._total).toBe(42);
  });
});

describe("envelopes", () => {
  it("parses the upstream success and failure envelopes", () => {
    expect(UpstreamEnvelopeSchema.parse({ errors: null, data: { ok: 1 } })).toEqual({ errors: null, data: { ok: 1 } });
    const failure = {
      errors: {
        errorCode: "SANDBOX_NOT_REACHABLE",
        errorMessage: "Sandbox is starting",
        errorDetails: { reason: "starting" },
      },
      data: null,
    };
    expect(upstreamEnvelopeSchema(VcaasProjectSchema.nullable()).parse(failure)).toEqual(failure);
  });

  it("discriminates the client envelope on ok", () => {
    const schema = vcaasResponseSchema(DeploymentStatusResultSchema);
    const ok = schema.parse({ ok: true, data: { status: "success", createdAt: "t" } });
    expect(ok.ok).toBe(true);
    const failed = schema.parse({
      ok: false,
      error: "Sandbox asleep",
      code: "UNKNOWN",
      upstreamCode: "SERVER_NOT_READY",
      data: null,
    });
    expect(failed.ok === false && (failed.upstreamCode ?? failed.code)).toBe("SERVER_NOT_READY");
    expect(schema.safeParse({ ok: false, error: "x", code: "SERVER_NOT_READY", data: null }).success).toBe(false);
  });
});
