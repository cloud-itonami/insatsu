import {
  asAgentTool,
  createKyselyDb,
  createWorkerExport,
  nowISO,
  nsid,
  sql,
  withCapabilityTags,
  type HostSDK,
} from "@etzhayyim/kotodama-host-sdk";
import {
  findSeedPartner,
  listSeedPartners,
  quotePrintMailJob,
  type ColorMode,
  type MailClass,
  type PrintMethod,
  type PrintPartner,
  type ServiceLevel,
} from "./print-network";

type JsonRow = Record<string, unknown>;

const APP_ID = "insatsu-ins4tup1";
const YUUBIN_DID = "did:web:yuubin.etzhayyim.com";

function json<T>(raw: unknown): T {
  if (!raw) return {} as T;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw)) as T;
  if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(raw))) as T;
  return raw as T;
}

function out(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function gid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function serializePartner(partner: PrintPartner): Record<string, unknown> {
  return {
    partnerDid: partner.partnerDid,
    slug: partner.slug,
    displayName: partner.displayName,
    country: partner.country,
    region: partner.region,
    printMethods: partner.printMethods,
    mailClasses: partner.mailClasses,
    supportsCertifiedMail: partner.supportsCertifiedMail,
    dailyCapacityPages: partner.dailyCapacityPages,
    baseCostUsd: partner.baseCostUsd,
    perPageUsd: partner.perPageUsd,
    serviceLevels: partner.serviceLevels,
    downstreamActorDid: partner.downstreamActorDid ?? null,
  };
}

const ACTOR_DID = "did:web:insatsu.etzhayyim.com";

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function parseDbValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value || !/^[\[{]/.test(value.trim())) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function typedRow(row: JsonRow): JsonRow {
  const out: JsonRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "vertex_id" || key === "sensitivity_ord" || key === "owner_did" || key === "actor_id") continue;
    out[snakeToCamel(key)] = parseDbValue(value);
  }
  return out;
}

async function insertInsatsuEdge(
  tableName: "edge_insatsu_partner_mail_job" | "edge_insatsu_job_downstream_actor",
  input: { srcVid: string; dstVid: string; relation: string; jobId?: unknown; createdAt?: unknown }
): Promise<void> {
  await createKyselyDb()
    .insertInto(tableName as any)
    .values({
      edge_id: gid("edge_insatsu"),
      src_vid: input.srcVid,
      dst_vid: input.dstVid,
      relation: input.relation,
      job_id: typeof input.jobId === "string" ? input.jobId : null,
      sensitivity_ord: 2,
      owner_did: ACTOR_DID,
      actor_id: APP_ID,
      created_at: input.createdAt ?? nowISO(),
    } as any)
    .execute();
}

async function writeRecord(_sdk: HostSDK, collection: string, record: Record<string, unknown>): Promise<void> {
  // Derive table name from last NSID segment: com.etzhayyim.apps.insatsu.printPartner → vertex_insatsu_print_partner
  const kind = collection.split(".").pop() ?? collection;
  const tableName = `vertex_insatsu_${camelToSnake(kind)}`;
  const rkey = String(record.jobId ?? record.slug ?? nowISO());
  const vertexId = `at://${ACTOR_DID}/${collection}/${rkey}`;
  const row: Record<string, unknown> = {
    vertex_id: vertexId,
    sensitivity_ord: 2,
    owner_did: ACTOR_DID,
    actor_id: APP_ID,
    created_at: record.createdAt ?? nowISO(),
  };
  for (const [k, v] of Object.entries(record)) {
    row[camelToSnake(k)] = v;
  }
  const db = createKyselyDb();
  await db.insertInto(tableName as any).values(row as any).execute();

  if (collection === "com.etzhayyim.apps.insatsu.printMailJob") {
    const partnerDid = typeof record.partnerDid === "string" ? record.partnerDid : "";
    if (partnerDid) {
      const partner = await db
        .selectFrom("vertex_insatsu_print_partner" as any)
        .select(["vertex_id"])
        .where("partner_did", "=", partnerDid)
        .limit(1)
        .executeTakeFirst();
      await insertInsatsuEdge("edge_insatsu_partner_mail_job", {
        srcVid: String(partner?.vertex_id ?? partnerDid),
        dstVid: vertexId,
        relation: "ROUTES_PRINT_MAIL_JOB",
        jobId: record.jobId,
        createdAt: record.createdAt,
      });
    }
    const downstreamActorDid = typeof record.downstreamActorDid === "string" ? record.downstreamActorDid : "";
    if (downstreamActorDid) {
      await insertInsatsuEdge("edge_insatsu_job_downstream_actor", {
        srcVid: vertexId,
        dstVid: downstreamActorDid,
        relation: "DISPATCHED_TO_ACTOR",
        jobId: record.jobId,
        createdAt: record.createdAt,
      });
    }
  }
}

function invoke(sdk: HostSDK, did: string, method: string, params: Record<string, unknown>): Record<string, unknown> {
  const raw = sdk.hostImports.invoke(did, method, JSON.stringify(params));
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function listRegisteredPartners(filters: {
  region?: string;
  country?: string;
  printMethod?: string;
  mailClass?: string;
}): Promise<Record<string, unknown>[]> {
  const db = createKyselyDb();
  let q = db
    .selectFrom("vertex_insatsu_print_partner" as any)
    .selectAll();
  if (filters.region) q = q.where("region", "=", filters.region);
  if (filters.country) q = q.where("country", "=", filters.country);
  if (filters.printMethod) q = q.where(sql<boolean>`coalesce(print_methods, '[]'::jsonb) ? ${filters.printMethod}`);
  if (filters.mailClass) q = q.where(sql<boolean>`coalesce(mail_classes, '[]'::jsonb) ? ${filters.mailClass}`);
  const rows = await q
    .orderBy("display_name", "asc")
    .limit(100)
    .execute();
  return rows.map((row) => typedRow(row as JsonRow));
}

async function findRegisteredPartner(input: { slug?: string; actorDid?: string }): Promise<Record<string, unknown> | null> {
  const db = createKyselyDb();
  let q = db
    .selectFrom("vertex_insatsu_print_partner" as any)
    .selectAll();
  if (input.slug) {
    q = q.where("slug", "=", input.slug);
  } else if (input.actorDid) {
    q = q.where("partner_did", "=", input.actorDid);
  } else {
    return null;
  }
  const row = await q.limit(1).executeTakeFirst();
  return row ? typedRow(row as JsonRow) : null;
}

async function findPrintMailJob(jobId: string): Promise<Record<string, unknown> | null> {
  const db = createKyselyDb();
  const row = await db
    .selectFrom("vertex_insatsu_print_mail_job" as any)
    .selectAll()
    .where("job_id", "=", jobId)
    .limit(1)
    .executeTakeFirst();
  return row ? typedRow(row as JsonRow) : null;
}

async function listPrintMailJobs(filters: { status?: string; destinationCountry?: string }, limit: number, offset: number): Promise<Record<string, unknown>[]> {
  const db = createKyselyDb();
  let q = db
    .selectFrom("vertex_insatsu_print_mail_job" as any)
    .selectAll();
  if (filters.status) q = q.where("status", "=", filters.status);
  if (filters.destinationCountry) q = q.where("destination_country", "=", filters.destinationCountry);
  const rows = await q
    .orderBy("created_at", "desc")
    .offset(offset)
    .limit(limit)
    .execute();
  return rows.map((row) => typedRow(row as JsonRow));
}

async function cmdRegisterPrintPartner(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{
    slug?: string;
    display_name?: string;
    country?: string;
    region?: string;
    print_methods?: string[];
    mail_classes?: string[];
    supports_certified_mail?: boolean;
    daily_capacity_pages?: number;
    base_cost_usd?: number;
    per_page_usd?: number;
    service_levels?: string[];
    downstream_actor_did?: string;
  }>(payload);

  const slug = str(args.slug);
  const displayName = str(args.display_name);
  const country = str(args.country).toUpperCase();
  if (!slug || !displayName || !country) {
    return out({ error: "missingRequiredFields", required: ["slug", "display_name", "country"] });
  }

  const partnerDid = `did:web:insatsu.etzhayyim.com:partner:${slug}`;
  const record = {
    partnerDid,
    slug,
    displayName,
    country,
    region: str(args.region),
    printMethods: args.print_methods ?? ["digital"],
    mailClasses: args.mail_classes ?? ["postal"],
    supportsCertifiedMail: !!args.supports_certified_mail,
    dailyCapacityPages: args.daily_capacity_pages ?? 0,
    baseCostUsd: args.base_cost_usd ?? 0,
    perPageUsd: args.per_page_usd ?? 0,
    serviceLevels: args.service_levels ?? ["standard"],
    downstreamActorDid: str(args.downstream_actor_did) || null,
  };

  await writeRecord(sdk, "com.etzhayyim.apps.insatsu.printPartner", record);
  return out({ status: "registered", partnerDid, slug });
}

async function cmdGetPrintPartner(_sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{ slug?: string; actor_did?: string }>(payload);
  const slug = str(args.slug);
  const actorDid = str(args.actor_did);
  const seed = findSeedPartner({ slug, actorDid });
  if (seed) return out(serializePartner(seed));
  const dynamic = await findRegisteredPartner({ slug, actorDid });
  if (dynamic) return out(dynamic);
  return out({ error: "notFound", slug: slug || undefined, actorDid: actorDid || undefined });
}

async function cmdListPrintPartners(_sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{ region?: string; country?: string; print_method?: string; mail_class?: string; limit?: number }>(payload);
  const limit = Math.min(args.limit ?? 50, 100);
  const filters = {
    region: str(args.region),
    country: str(args.country).toUpperCase(),
    printMethod: str(args.print_method),
    mailClass: str(args.mail_class),
  };
  const seed = listSeedPartners(filters).map(serializePartner);
  const dynamic = await listRegisteredPartners(filters);
  const merged = [...seed];
  for (const item of dynamic) {
    if (!merged.some((existing) => existing.partnerDid === item.partnerDid)) merged.push(item);
  }
  return out({ items: merged.slice(0, limit), total: merged.length, limit });
}

function cmdQuotePrintMailJob(_sdk: HostSDK, payload: Uint8Array): Uint8Array {
  const args = json<{
    destination_country?: string;
    page_count?: number;
    quantity?: number;
    print_method?: string;
    mail_class?: string;
    service_level?: string;
    color_mode?: string;
  }>(payload);
  const destinationCountry = str(args.destination_country).toUpperCase();
  if (!destinationCountry || !args.page_count || !args.quantity) {
    return out({ error: "missingRequiredFields", required: ["destination_country", "page_count", "quantity"] });
  }
  const quote = quotePrintMailJob({
    destinationCountry,
    pageCount: args.page_count,
    quantity: args.quantity,
    printMethod: str(args.print_method) as PrintMethod,
    mailClass: str(args.mail_class) as MailClass,
    serviceLevel: str(args.service_level) as ServiceLevel,
    colorMode: str(args.color_mode) as ColorMode,
  });
  if (!quote) return out({ error: "noEligiblePartner" });
  return out(quote);
}

async function cmdCreatePrintMailJob(sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{
    document_url?: string;
    destination_country?: string;
    recipient_name?: string;
    address_line1?: string;
    postal_code?: string;
    page_count?: number;
    quantity?: number;
    print_method?: string;
    mail_class?: string;
    service_level?: string;
    case_id?: string;
    subject?: string;
  }>(payload);

  const documentUrl = str(args.document_url);
  const destinationCountry = str(args.destination_country).toUpperCase();
  if (!documentUrl || !destinationCountry || !args.page_count || !args.quantity) {
    return out({ error: "missingRequiredFields", required: ["document_url", "destination_country", "page_count", "quantity"] });
  }

  const quote = quotePrintMailJob({
    destinationCountry,
    pageCount: args.page_count,
    quantity: args.quantity,
    printMethod: str(args.print_method) as PrintMethod,
    mailClass: str(args.mail_class) as MailClass,
    serviceLevel: str(args.service_level) as ServiceLevel,
  });
  if (!quote) return out({ error: "noEligiblePartner" });

  const jobId = gid("pmj");
  let downstreamDispatch: Record<string, unknown> | null = null;
  let status = quote.downstreamActorDid ? "dispatched" : "queued";
  if (quote.downstreamActorDid === YUUBIN_DID && destinationCountry === "JPN") {
    downstreamDispatch = invoke(sdk, YUUBIN_DID, "com.etzhayyim.apps.yuubin.composeAndPost", {
      url: documentUrl,
      subject: str(args.subject),
      caseId: str(args.case_id),
      deliveryMethod: str(args.mail_class) === "express" ? "express" : "regular",
      provider: "manual",
      to: {
        postalCode: str(args.postal_code),
        cityWardLine1: str(args.address_line1),
        recipientName: str(args.recipient_name),
      },
    });
  }

  const record = {
    jobId,
    status,
    documentUrl,
    destinationCountry,
    recipientName: str(args.recipient_name),
    addressLine1: str(args.address_line1),
    postalCode: str(args.postal_code),
    pageCount: args.page_count,
    quantity: args.quantity,
    printMethod: str(args.print_method) || "digital",
    mailClass: str(args.mail_class) || "postal",
    serviceLevel: str(args.service_level) || "standard",
    partnerDid: quote.partnerDid,
    partnerDisplayName: quote.partnerDisplayName,
    routeType: quote.routeType,
    downstreamActorDid: quote.downstreamActorDid,
    estimatedCostUsd: quote.estimatedCostUsd,
    estimatedTotalDays: quote.estimatedTotalDays,
    caseId: str(args.case_id),
    subject: str(args.subject),
    downstreamDispatch,
    createdAt: nowISO(),
  };
  await writeRecord(sdk, "com.etzhayyim.apps.insatsu.printMailJob", record);

  return out({
    jobId,
    status,
    partnerDid: quote.partnerDid,
    downstreamActorDid: quote.downstreamActorDid,
    routeType: quote.routeType,
  });
}

async function cmdGetPrintMailJob(_sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{ job_id?: string }>(payload);
  const jobId = str(args.job_id);
  if (!jobId) return out({ error: "missingJobId" });
  const job = await findPrintMailJob(jobId);
  return out(job ?? { error: "notFound", jobId });
}

async function cmdListPrintMailJobs(_sdk: HostSDK, payload: Uint8Array): Promise<Uint8Array> {
  const args = json<{ status?: string; destination_country?: string; limit?: number; offset?: number }>(payload);
  const limit = Math.min(args.limit ?? 50, 100);
  const offset = args.offset ?? 0;
  const items = await listPrintMailJobs(
    { status: str(args.status), destinationCountry: str(args.destination_country).toUpperCase() },
    limit,
    offset
  );
  return out({ items, total: items.length, limit, offset });
}

export default createWorkerExport((sdk) => {
  sdk.app
    .command(
      nsid("com.etzhayyim.apps.insatsu.printPartner.registerPrintPartner"),
      async (_c, body) => cmdRegisterPrintPartner(sdk, body),
      asAgentTool("Register a regional print partner in the insatsu network."),
      withCapabilityTags("print-partner", "write")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printPartner.getPrintPartner"),
      async (_c, body) => cmdGetPrintPartner(sdk, body),
      asAgentTool("Resolve a cloud print partner by slug or actor DID."),
      withCapabilityTags("print-partner", "read")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printPartner.listPrintPartners"),
      async (_c, body) => cmdListPrintPartners(sdk, body),
      asAgentTool("List cloud print partners by region and capability."),
      withCapabilityTags("print-partner", "read")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printMailJob.quotePrintMailJob"),
      async (_c, body) => cmdQuotePrintMailJob(sdk, body),
      asAgentTool("Quote and route a print-and-mail job."),
      withCapabilityTags("print-mail-job", "read")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printMailJob.createPrintMailJob"),
      async (_c, body) => cmdCreatePrintMailJob(sdk, body),
      asAgentTool("Create a print-and-mail job and dispatch downstream when possible."),
      withCapabilityTags("print-mail-job", "write")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printMailJob.getPrintMailJob"),
      async (_c, body) => cmdGetPrintMailJob(sdk, body),
      asAgentTool("Get a cloud print-and-mail job by ID."),
      withCapabilityTags("print-mail-job", "read")
    )
    .command(
      nsid("com.etzhayyim.apps.insatsu.printMailJob.listPrintMailJobs"),
      async (_c, body) => cmdListPrintMailJobs(sdk, body),
      asAgentTool("List cloud print-and-mail jobs."),
      withCapabilityTags("print-mail-job", "read")
    );
});
