/**
 * insatsu kotoba — kotoba-E2E split registry.
 *
 * Plaintext path (printPartner): sdk.write / sdk.read — public print-shop
 * catalog (capabilities, capacity, pricing). register / get / list + countAll.
 * E2E path (printMailJob): sdk.encryptedWrite / sdk.encryptedRead — postal PII +
 * document chain-of-custody sealed in the kotoba envelope (ADR-2605181100),
 * read-cap = owner DID. The substrate never sees recipient PII in plaintext.
 *
 * Cross-layer FK: a job's `partnerDid` MUST exist in the plaintext partner
 * catalog (enforced via exists() against the plaintext collection before the
 * E2E write).
 *
 * STAYS etzhayyim: print production, yuubin postal dispatch, quote/scoring engine,
 * fiat settlement — consumed via consent-capability, never collections here.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  JOB_INNER_TYPE,
  PARTNER_COLLECTION,
  isDecimalString,
  isUint,
  jobRkey,
  partnerDidFor,
  partnerRkey,
  type CoverageInput,
  type CoverageOutput,
  type GetJobInput,
  type GetJobOutput,
  type GetPartnerInput,
  type GetPartnerOutput,
  type ListJobsInput,
  type ListJobsOutput,
  type ListPartnersInput,
  type ListPartnersOutput,
  type PrintMailJobBody,
  type PrintMailJobView,
  type PrintPartnerRecord,
  type PrintPartnerView,
  type RecordJobInput,
  type RecordJobOutput,
  type RegisterPartnerInput,
  type RegisterPartnerOutput,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

// ─── Print partner (PLAINTEXT) ──────────────────────────────────────

export async function registerPartner(e: Etzhayyim, input: RegisterPartnerInput): Promise<RegisterPartnerOutput> {
  if (!input.slug || !input.displayName || !input.country) return { status: "rejected", error: "missingRequiredFields" };
  if (input.dailyCapacityPages !== undefined && !isUint(input.dailyCapacityPages)) return { status: "rejected", error: "invalidDailyCapacityPages" };
  if (input.baseCostUsd !== undefined && !isDecimalString(input.baseCostUsd)) return { status: "rejected", error: "invalidBaseCostUsd" };
  if (input.perPageUsd !== undefined && !isDecimalString(input.perPageUsd)) return { status: "rejected", error: "invalidPerPageUsd" };
  const rkey = partnerRkey(input.slug);
  const existing = await e.read<PrintPartnerRecord>({ collection: PARTNER_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", partnerUri: existing.records[0].uri, partnerDid: existing.records[0].value.partnerDid, slug: input.slug };
  }
  const now = new Date().toISOString();
  const partnerDid = partnerDidFor(input.slug);
  const record: PrintPartnerRecord = {
    did: partnerDid,
    partnerDid,
    slug: input.slug,
    displayName: input.displayName,
    country: input.country.toUpperCase(),
    region: input.region ?? "",
    printMethods: input.printMethods ?? ["digital"],
    mailClasses: input.mailClasses ?? ["postal"],
    supportsCertifiedMail: !!input.supportsCertifiedMail,
    dailyCapacityPages: input.dailyCapacityPages ?? 0,
    baseCostUsd: input.baseCostUsd ?? "0",
    perPageUsd: input.perPageUsd ?? "0",
    serviceLevels: input.serviceLevels ?? ["standard"],
    downstreamActorDid: input.downstreamActorDid ?? null,
    createdAt: now,
  };
  const receipt = await e.write({ collection: PARTNER_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "registered", partnerUri: receipt.uri, partnerDid, slug: input.slug };
}

export async function getPartner(e: Etzhayyim, input: GetPartnerInput): Promise<GetPartnerOutput> {
  if (!input.slug) return { error: "invalidSlug" };
  const resp = await e.read<PrintPartnerRecord>({ collection: PARTNER_COLLECTION, rkey: partnerRkey(input.slug) });
  const rec = resp.records[0];
  if (!rec?.value) return { error: "notFound" };
  return { partner: { ...rec.value, partnerUri: rec.uri } };
}

export async function listPartners(e: Etzhayyim, input: ListPartnersInput = {}): Promise<ListPartnersOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<PrintPartnerRecord>({ collection: PARTNER_COLLECTION, cursor: input.cursor, limit });
  const items: PrintPartnerView[] = resp.records
    .filter((r) => !input.region || r.value.region === input.region)
    .filter((r) => !input.country || r.value.country === input.country.toUpperCase())
    .map((r) => ({ ...r.value, partnerUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

/** Cross-layer FK helper: does a partner with this DID exist in the plaintext catalog? */
async function partnerExists(e: Etzhayyim, partnerDid: string, maxScan: number): Promise<boolean> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const page = await e.read<PrintPartnerRecord>({ collection: PARTNER_COLLECTION, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      scanned += 1;
      if (r.value.partnerDid === partnerDid) return true;
    }
    if (!page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  return false;
}

// ─── Print-mail job (E2E-ENCRYPTED, postal PII / CUI) ────────────────

export async function recordJob(e: Etzhayyim, input: RecordJobInput): Promise<RecordJobOutput> {
  if (!input.jobId || !input.partnerDid || !input.documentUrl || !input.destinationCountry) {
    return { status: "rejected", error: "missingRequiredFields" };
  }
  if (!isUint(input.pageCount) || !isUint(input.quantity)) return { status: "rejected", error: "invalidPageOrQuantity" };
  if (input.estimatedCostUsd !== undefined && !isDecimalString(input.estimatedCostUsd)) return { status: "rejected", error: "invalidEstimatedCostUsd" };
  if (input.estimatedTotalDays !== undefined && !isUint(input.estimatedTotalDays)) return { status: "rejected", error: "invalidEstimatedTotalDays" };
  // Cross-layer FK: partner must exist in the plaintext catalog.
  if (!(await partnerExists(e, input.partnerDid, DEFAULT_MAX_SCAN))) {
    return { status: "rejected", error: "unknownPartner" };
  }
  const body: PrintMailJobBody = {
    jobId: input.jobId,
    partnerDid: input.partnerDid,
    status: input.status ?? "queued",
    documentUrl: input.documentUrl,
    destinationCountry: input.destinationCountry.toUpperCase(),
    recipientName: input.recipientName ?? "",
    addressLine1: input.addressLine1 ?? "",
    postalCode: input.postalCode ?? "",
    pageCount: input.pageCount,
    quantity: input.quantity,
    printMethod: input.printMethod ?? "digital",
    mailClass: input.mailClass ?? "postal",
    serviceLevel: input.serviceLevel ?? "standard",
    estimatedCostUsd: input.estimatedCostUsd ?? "0",
    estimatedTotalDays: input.estimatedTotalDays ?? 0,
    caseId: input.caseId ?? "",
    subject: input.subject ?? "",
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };
  // Read-cap = owner DID (sender, auto-wrapped) + any explicit recipients.
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: JOB_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: jobRkey(input.jobId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, jobId: input.jobId };
}

async function scanJobs(e: Etzhayyim, maxScan: number): Promise<PrintMailJobView[]> {
  const out: PrintMailJobView[] = [];
  let cursor: string | undefined;
  while (out.length < maxScan) {
    const page = await e.encryptedRead<PrintMailJobBody>({ innerType: JOB_INNER_TYPE, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      out.push({ ...r.value, uri: r.uri, sender: r.sender, createdAt: r.createdAt });
    }
    if (!page.cursor || page.records.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

export async function listJobs(e: Etzhayyim, input: ListJobsInput = {}): Promise<ListJobsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanJobs(e, DEFAULT_MAX_SCAN);
  const filtered = all
    .filter((j) => !input.destinationCountry || j.destinationCountry === input.destinationCountry.toUpperCase())
    .filter((j) => !input.status || j.status === input.status);
  return { items: filtered.slice(0, limit), total: filtered.length };
}

export async function getJob(e: Etzhayyim, input: GetJobInput): Promise<GetJobOutput> {
  if (!input.jobId) return { error: "invalidJobId" };
  const all = await scanJobs(e, DEFAULT_MAX_SCAN);
  const found = all.find((j) => j.jobId === input.jobId);
  if (!found) return { error: "notFound" };
  return { job: found };
}

// ─── Coverage rollup (counts only) ──────────────────────────────────

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  let printPartnerCount = 0;
  let cursor: string | undefined;
  while (printPartnerCount < maxScan) {
    const page = await e.read<PrintPartnerRecord>({ collection: PARTNER_COLLECTION, cursor, limit: PAGE_LIMIT });
    printPartnerCount += page.records.length;
    if (!page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  const jobs = await scanJobs(e, maxScan);
  const jobsByDestinationCountry: Record<string, number> = {};
  for (const j of jobs) {
    jobsByDestinationCountry[j.destinationCountry] = (jobsByDestinationCountry[j.destinationCountry] ?? 0) + 1;
  }
  return {
    printPartnerCount,
    printMailJobCount: jobs.length,
    jobsByDestinationCountry,
    truncated: printPartnerCount >= maxScan || jobs.length >= maxScan,
  };
}
