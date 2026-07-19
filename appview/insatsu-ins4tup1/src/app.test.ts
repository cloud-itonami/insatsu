import { beforeEach, describe, expect, it, vi } from "vitest";

type DispatchCall = { type: string; payload: Record<string, unknown> };
type InvokeCall = { did: string; method: string; params: string };
type InsertCall = { table: string; values: Record<string, unknown> };

let dispatchCalls: DispatchCall[] = [];
let invokeCalls: InvokeCall[] = [];
let insertCalls: InsertCall[] = [];
let invokeResponses: Record<string, string> = {};
let sqlResults: Record<string, unknown>[][] = [];
let sqlCallCount = 0;

function resetState() {
  dispatchCalls = [];
  invokeCalls = [];
  insertCalls = [];
  invokeResponses = {};
  sqlResults = [];
  sqlCallCount = 0;
}

function createSdk() {
  return {
    pds: {
      dispatch(call: DispatchCall) { dispatchCalls.push(call); },
    },
    hostImports: {
      invoke(did: string, method: string, params: string): string {
        invokeCalls.push({ did, method, params });
        return invokeResponses[`${did}:${method}`] ?? "{}";
      },
    },
    app: {
      command: vi.fn().mockReturnThis(),
    },
  };
}

function createQueryMock() {
  let insertTable: string | null = null;
  const query = {
    insertInto: vi.fn((table: string) => {
      insertTable = table;
      return query;
    }),
    values: vi.fn((values: Record<string, unknown>) => {
      insertCalls.push({ table: insertTable ?? "", values });
      return query;
    }),
    selectFrom: vi.fn(() => query),
    select: vi.fn(() => query),
    selectAll: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    offset: vi.fn(() => query),
    execute: vi.fn(async () => {
      if (insertTable) return [];
      return sqlResults[sqlCallCount++] ?? [];
    }),
    executeTakeFirst: vi.fn(async () => (sqlResults[sqlCallCount++] ?? [])[0]),
  };
  return query;
}

let setupCallback: ((sdk: ReturnType<typeof createSdk>) => void) | null = null;

vi.mock("@etzhayyim/kotodama-host-sdk", () => ({
  createWorkerExport: (cb: (sdk: ReturnType<typeof createSdk>) => void) => {
    setupCallback = cb;
    return { fetch: vi.fn() };
  },
  asAgentTool: (desc: string) => ({ type: "agentTool", desc }),
  withCapabilityTags: (...tags: string[]) => ({ type: "capTags", tags }),
  createKyselyDb: () => createQueryMock(),
  nowISO: () => "2026-04-23T00:00:00.000Z",
  nsid: (value: string) => value,
}));

// CHARTER-VIOLATION §substrate (centralized DB forbidden — migrate to AT MST + IPFS + Base L2)
vi.mock("kysely", () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({ values }),
}));

let appModule: typeof import("./app");

beforeEach(async () => {
  vi.resetModules();
  resetState();
  setupCallback = null;
  appModule = await import("./app");
});

async function dec(input: Uint8Array | Promise<Uint8Array>) {
  return JSON.parse(new TextDecoder().decode(await input)) as Record<string, unknown>;
}

function enc(input: unknown) {
  return new TextEncoder().encode(JSON.stringify(input));
}

function getHandler(nsid: string) {
  const sdk = createSdk();
  setupCallback!(sdk);
  const call = sdk.app.command.mock.calls.find((entry: unknown[]) => entry[0] === nsid);
  return call?.[1] as ((ctx: unknown, body: Uint8Array) => Uint8Array | Promise<Uint8Array>);
}

describe("insatsu command registration", () => {
  it("registers expected commands", () => {
    const sdk = createSdk();
    setupCallback!(sdk);
    const nsids = sdk.app.command.mock.calls.map((call: unknown[]) => call[0]);
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printPartner.registerPrintPartner");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printPartner.getPrintPartner");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printPartner.listPrintPartners");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printMailJob.quotePrintMailJob");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printMailJob.createPrintMailJob");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printMailJob.getPrintMailJob");
    expect(nsids).toContain("com.etzhayyim.apps.insatsu.printMailJob.listPrintMailJobs");
  });
});

describe("print partners", () => {
  it("returns seeded partner by slug", async () => {
    const handler = getHandler("com.etzhayyim.apps.insatsu.printPartner.getPrintPartner")!;
    const result = await dec(handler(null, enc({ slug: "tokyo-printpost" })));
    expect(result.partnerDid).toBe("did:web:insatsu.etzhayyim.com:partner:tokyo-printpost");
    expect(result.downstreamActorDid).toBe("did:web:yuubin.etzhayyim.com");
  });

  it("lists seeded APAC partners", async () => {
    const handler = getHandler("com.etzhayyim.apps.insatsu.printPartner.listPrintPartners")!;
    const result = await dec(handler(null, enc({ region: "APAC" })));
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect((result.items as Record<string, unknown>[]).some((item) => item.slug === "tokyo-printpost")).toBe(true);
  });

  it("registers a dynamic partner", async () => {
    const handler = getHandler("com.etzhayyim.apps.insatsu.printPartner.registerPrintPartner")!;
    const result = await dec(handler(null, enc({
      slug: "paris-mail-factory",
      display_name: "Paris Mail Factory",
      country: "FRA",
      region: "EMEA",
    })));
    expect(result.status).toBe("registered");
    expect(insertCalls[0].table).toBe("vertex_insatsu_print_partner");
    expect(insertCalls[0].values.slug).toBe("paris-mail-factory");
  });
});

describe("print mail jobs", () => {
  it("quotes Japan route via yuubin handoff", async () => {
    const handler = getHandler("com.etzhayyim.apps.insatsu.printMailJob.quotePrintMailJob")!;
    const result = await dec(handler(null, enc({
      destination_country: "JPN",
      page_count: 4,
      quantity: 10,
      print_method: "digital",
      mail_class: "registered",
      service_level: "standard",
    })));
    expect(result.partnerDid).toBe("did:web:insatsu.etzhayyim.com:partner:tokyo-printpost");
    expect(result.downstreamActorDid).toBe("did:web:yuubin.etzhayyim.com");
    expect(result.routeType).toBe("postal-handoff");
  });

  it("creates Japan job and invokes yuubin", async () => {
    invokeResponses["did:web:yuubin.etzhayyim.com:com.etzhayyim.apps.yuubin.composeAndPost"] = JSON.stringify({ ok: true, txId: "post_123" });
    const handler = getHandler("com.etzhayyim.apps.insatsu.printMailJob.createPrintMailJob")!;
    const result = await dec(handler(null, enc({
      document_url: "https://cdn.example.com/doc.pdf",
      destination_country: "JPN",
      recipient_name: "Tokyo District Court",
      address_line1: "Kasumigaseki 1-1-4",
      postal_code: "100-8920",
      page_count: 6,
      quantity: 1,
      print_method: "digital",
      mail_class: "registered",
      service_level: "standard",
      case_id: "case-1",
    })));
    expect(result.status).toBe("dispatched");
    expect(result.downstreamActorDid).toBe("did:web:yuubin.etzhayyim.com");
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].method).toBe("com.etzhayyim.apps.yuubin.composeAndPost");
    expect(insertCalls.some((call) => call.table === "vertex_insatsu_print_mail_job")).toBe(true);
    expect(insertCalls.some((call) => call.table === "edge_insatsu_partner_mail_job")).toBe(true);
    expect(insertCalls.some((call) => call.table === "edge_insatsu_job_downstream_actor")).toBe(true);
  });

  it("creates non-Japan job without downstream invoke", async () => {
    const handler = getHandler("com.etzhayyim.apps.insatsu.printMailJob.createPrintMailJob")!;
    const result = await dec(handler(null, enc({
      document_url: "https://cdn.example.com/de.pdf",
      destination_country: "DEU",
      recipient_name: "Berlin HQ",
      address_line1: "Unter den Linden 1",
      postal_code: "10117",
      page_count: 12,
      quantity: 50,
      print_method: "offset",
      mail_class: "postal",
      service_level: "standard",
    })));
    expect(result.status).toBe("queued");
    expect(result.downstreamActorDid).toBe(null);
    expect(invokeCalls).toHaveLength(0);
  });

  it("gets print mail job from projected records", async () => {
    sqlResults = [[{
      jobId: "pmj_abc",
      status: "queued",
      partnerDid: "did:web:insatsu.etzhayyim.com:partner:berlin-direct-mail",
    }]];
    const handler = getHandler("com.etzhayyim.apps.insatsu.printMailJob.getPrintMailJob")!;
    const result = await dec(handler(null, enc({ job_id: "pmj_abc" })));
    expect(result.jobId).toBe("pmj_abc");
    expect(result.status).toBe("queued");
  });
});
