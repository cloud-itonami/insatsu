/**
 * insatsu kotoba — barrel. kotoba-E2E split: plaintext public print-partner
 * catalog + E2E-sealed printMailJob (postal PII / document chain-of-custody,
 * ADR-2605181100). Print production / yuubin postal dispatch / quote engine /
 * fiat settlement stay etzhayyim via consent-capability.
 */
export * from "./types.js";
export {
  registerPartner,
  getPartner,
  listPartners,
  recordJob,
  listJobs,
  getJob,
  coverage,
} from "./registry.js";
