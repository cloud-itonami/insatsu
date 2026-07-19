/**
 * insatsu kotoba — kotoba-E2E split (plaintext public catalog + E2E-sealed
 * postal PII / document chain-of-custody).
 *
 * Per ADR-2606011400 (Consensys) + ADR-2605172400 (3-axis) + ADR-2605181100
 * (kotoba E2E encrypted-record envelope). Founder directive 2026-06-03: PII /
 * CUI / LE may migrate to etzhayyim when made safe via kotoba E2E.
 *
 * SPLIT:
 *   PUBLIC (plaintext AT records) — printPartner: the regional print-shop
 *   catalog (capabilities, capacity, pricing). Pricing is already in-repo seed
 *   data, so it is open catalog metadata; no subject PII. Frontable.
 *   SENSITIVE (kotoba E2E, com.etzhayyim.encrypted.record) — printMailJob:
 *   recipient name / postal address / postal code / document URL / case id /
 *   subject = postal-operator PII + document-production chain-of-custody (the
 *   manifest's `classification: confidential` + cross-border-data-minimization
 *   applies here). Written via sdk.encryptedWrite (read-cap = owner DID), so the
 *   substrate never sees recipient PII in plaintext.
 *
 *   STAYS etzhayyim (consumed via consent-capability) — print PRODUCTION execution,
 *   the yuubin `composeAndPost` postal-injection dispatch (blocking fulfillment
 *   action), the quote/scoring engine, and fiat settlement of print/postage
 *   costs. The job DATA record migrates; the regulated *acts* stay etzhayyim.
 *
 * AT-Lexicon: no float. Money/decimals as decimal STRINGS (estimatedCostUsd,
 * baseCostUsd, perPageUsd). Counts/pages/quantity/days as integers.
 */

// Plaintext public collection.
export const PARTNER_COLLECTION = "com.etzhayyim.apps.insatsu.printPartner";
// E2E inner-type NSID (body shape inside the encrypted envelope).
export const JOB_INNER_TYPE = "com.etzhayyim.apps.insatsu.printMailJob";

export const INSATSU_DID_PREFIX = "did:web:insatsu.etzhayyim.com:" as const;

// ─── Print partner (PLAINTEXT, public catalog) ──────────────────────

export interface PrintPartnerRecord {
  did: string;
  partnerDid: string;
  slug: string;
  displayName: string;
  country: string;
  region: string;
  printMethods: string[];
  mailClasses: string[];
  supportsCertifiedMail: boolean;
  dailyCapacityPages: number;
  /** decimal STRING (USD). */
  baseCostUsd: string;
  /** decimal STRING (USD). */
  perPageUsd: string;
  serviceLevels: string[];
  downstreamActorDid: string | null;
  createdAt: string;
}
export interface PrintPartnerView extends PrintPartnerRecord {
  partnerUri: string;
}
export interface RegisterPartnerInput {
  slug: string;
  displayName: string;
  country: string;
  region?: string;
  printMethods?: string[];
  mailClasses?: string[];
  supportsCertifiedMail?: boolean;
  dailyCapacityPages?: number;
  baseCostUsd?: string;
  perPageUsd?: string;
  serviceLevels?: string[];
  downstreamActorDid?: string;
}
export interface RegisterPartnerOutput {
  status: "registered" | "alreadyExists" | "rejected";
  partnerUri?: string;
  partnerDid?: string;
  slug?: string;
  error?: string;
}
export interface GetPartnerInput {
  slug: string;
}
export interface GetPartnerOutput {
  partner?: PrintPartnerView;
  error?: string;
}
export interface ListPartnersInput {
  region?: string;
  country?: string;
  limit?: number;
  cursor?: string;
}
export interface ListPartnersOutput {
  items: PrintPartnerView[];
  cursor?: string;
  total: number;
}

// ─── Print-mail job (E2E-ENCRYPTED, postal PII / CUI) ────────────────

export interface PrintMailJobBody {
  jobId: string;
  partnerDid: string;
  status: string;
  documentUrl: string;
  destinationCountry: string;
  recipientName: string;
  addressLine1: string;
  postalCode: string;
  pageCount: number;
  quantity: number;
  printMethod: string;
  mailClass: string;
  serviceLevel: string;
  /** decimal STRING (USD). */
  estimatedCostUsd: string;
  /** integer days. */
  estimatedTotalDays: number;
  caseId: string;
  subject: string;
  submittedAt: string;
}
export interface PrintMailJobView extends PrintMailJobBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordJobInput {
  jobId: string;
  partnerDid: string;
  documentUrl: string;
  destinationCountry: string;
  recipientName: string;
  addressLine1: string;
  postalCode: string;
  pageCount: number;
  quantity: number;
  printMethod?: string;
  mailClass?: string;
  serviceLevel?: string;
  status?: string;
  estimatedCostUsd?: string;
  estimatedTotalDays?: number;
  caseId?: string;
  subject?: string;
  submittedAt?: string;
  /** Extra DIDs to grant read-cap (owner always included). */
  recipients?: string[];
}
export interface RecordJobOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  jobId?: string;
  error?: string;
}
export interface ListJobsInput {
  destinationCountry?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}
export interface ListJobsOutput {
  items: PrintMailJobView[];
  cursor?: string;
  total: number;
}
export interface GetJobInput {
  jobId: string;
}
export interface GetJobOutput {
  job?: PrintMailJobView;
  error?: string;
}

// ─── Coverage rollup (counts only — never sum decimal strings) ───────

export interface CoverageInput {
  maxScan?: number;
}
export interface CoverageOutput {
  printPartnerCount?: number;
  printMailJobCount?: number;
  jobsByDestinationCountry?: Record<string, number>;
  truncated?: boolean;
  error?: string;
}

// ─── Validation + helpers ───────────────────────────────────────────

export function isUint(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}
export function isDecimalString(s: unknown): s is string {
  return typeof s === "string" && /^\d+(\.\d+)?$/.test(s);
}
export function partnerDidFor(slug: string): string {
  return `${INSATSU_DID_PREFIX}partner:${slug.toLowerCase()}`;
}
export function partnerRkey(slug: string): string {
  return `partner-${slug.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
export function jobRkey(jobId: string): string {
  return `job-${jobId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
