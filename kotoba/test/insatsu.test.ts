import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  registerPartner,
  getPartner,
  listPartners,
  recordJob,
  listJobs,
  getJob,
  coverage,
  partnerDidFor,
} from "../src/index.js";

const OWNER = "did:web:insatsu.etzhayyim.com";

describe("insatsu kotoba (kotoba-E2E split)", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: OWNER });
  });

  describe("printPartner (PLAINTEXT public catalog)", () => {
    it("registers, dedups, validates, gets, lists/filters", async () => {
      expect(
        (await registerPartner(e, { slug: "tokyo-printpost", displayName: "Tokyo PrintPost", country: "jpn", region: "APAC", baseCostUsd: "6", perPageUsd: "0.035", dailyCapacityPages: 180000 })).status
      ).toBe("registered");
      // dedup
      expect((await registerPartner(e, { slug: "tokyo-printpost", displayName: "Tokyo PrintPost", country: "JPN" })).status).toBe("alreadyExists");
      // money must be a decimal string, not a float
      expect((await registerPartner(e, { slug: "bad", displayName: "B", country: "JPN", baseCostUsd: "12.5x" })).status).toBe("rejected");
      // missing required
      expect((await registerPartner(e, { slug: "", displayName: "X", country: "JPN" })).status).toBe("rejected");

      await registerPartner(e, { slug: "berlin-direct-mail", displayName: "Berlin Direct Mail", country: "DEU", region: "EMEA", baseCostUsd: "8", perPageUsd: "0.038" });

      // get by slug (country uppercased on write)
      const got = await getPartner(e, { slug: "tokyo-printpost" });
      expect(got.partner?.country).toBe("JPN");
      expect(got.partner?.baseCostUsd).toBe("6");
      expect((await getPartner(e, { slug: "nope" })).error).toBe("notFound");

      expect((await listPartners(e)).total).toBe(2);
      expect((await listPartners(e, { region: "APAC" })).total).toBe(1);
      expect((await listPartners(e, { country: "deu" })).total).toBe(1);
    });
  });

  describe("printMailJob (E2E-ENCRYPTED postal PII / chain-of-custody)", () => {
    beforeEach(async () => {
      await registerPartner(e, { slug: "tokyo-printpost", displayName: "Tokyo PrintPost", country: "JPN" });
    });

    it("seals via encryptedWrite, round-trips via encryptedRead, validates", async () => {
      const partnerDid = partnerDidFor("tokyo-printpost");
      const ok = await recordJob(e, {
        jobId: "j1",
        partnerDid,
        documentUrl: "https://docs.example/letter.pdf",
        destinationCountry: "jpn",
        recipientName: "Taro Yamada",
        addressLine1: "1-2-3 Chiyoda",
        postalCode: "100-0001",
        pageCount: 4,
        quantity: 1,
        estimatedCostUsd: "12.50",
        estimatedTotalDays: 3,
        caseId: "CASE-9",
        subject: "Notice",
      });
      expect(ok.status).toBe("recorded");
      expect(ok.keyId).toBeTruthy();

      // float-as-string guard: bad cost string rejected
      expect((await recordJob(e, { jobId: "jX", partnerDid, documentUrl: "u", destinationCountry: "JPN", recipientName: "", addressLine1: "", postalCode: "", pageCount: 1, quantity: 1, estimatedCostUsd: "1.2.3" })).status).toBe("rejected");

      // round-trip — PII is recovered from the sealed body
      const got = await getJob(e, { jobId: "j1" });
      expect(got.job?.recipientName).toBe("Taro Yamada");
      expect(got.job?.postalCode).toBe("100-0001");
      expect(got.job?.estimatedCostUsd).toBe("12.50");
      expect(got.job?.estimatedTotalDays).toBe(3);

      await recordJob(e, { jobId: "j2", partnerDid, documentUrl: "u2", destinationCountry: "USA", recipientName: "Jane", addressLine1: "5 Main", postalCode: "60601", pageCount: 2, quantity: 3 });
      expect((await listJobs(e)).total).toBe(2);
      expect((await listJobs(e, { destinationCountry: "jpn" })).total).toBe(1);
      expect((await listJobs(e, { status: "queued" })).total).toBe(2);
    });

    it("enforces cross-layer FK: job for an unknown partner is rejected", async () => {
      const r = await recordJob(e, {
        jobId: "jFK",
        partnerDid: partnerDidFor("ghost-shop"),
        documentUrl: "u",
        destinationCountry: "JPN",
        recipientName: "X",
        addressLine1: "",
        postalCode: "",
        pageCount: 1,
        quantity: 1,
      });
      expect(r.status).toBe("rejected");
      expect(r.error).toBe("unknownPartner");
    });

    it("enforces read-cap: a non-recipient DID cannot decrypt the job", async () => {
      await recordJob(e, { jobId: "j1", partnerDid: partnerDidFor("tokyo-printpost"), documentUrl: "u", destinationCountry: "JPN", recipientName: "Secret", addressLine1: "", postalCode: "", pageCount: 1, quantity: 1 });
      const outsider: any = new MockEtzhayyim({ did: "did:web:outsider.example" });
      expect((await listJobs(outsider)).total).toBe(0);
    });

    it("grants read-cap to an explicit recipient", async () => {
      const partner = "did:web:partner.example";
      const r = await recordJob(e, { jobId: "j1", partnerDid: partnerDidFor("tokyo-printpost"), documentUrl: "u", destinationCountry: "JPN", recipientName: "Y", addressLine1: "", postalCode: "", pageCount: 1, quantity: 1, recipients: [partner] });
      expect(r.status).toBe("recorded");
      expect((await listJobs(e)).total).toBe(1);
    });
  });

  describe("coverage rollup (counts only)", () => {
    it("counts plaintext partners + E2E jobs by destination", async () => {
      await registerPartner(e, { slug: "tokyo-printpost", displayName: "Tokyo", country: "JPN" });
      await registerPartner(e, { slug: "chicago-print", displayName: "Chicago", country: "USA" });
      const pd = partnerDidFor("tokyo-printpost");
      await recordJob(e, { jobId: "j1", partnerDid: pd, documentUrl: "u", destinationCountry: "JPN", recipientName: "A", addressLine1: "", postalCode: "", pageCount: 1, quantity: 1 });
      await recordJob(e, { jobId: "j2", partnerDid: pd, documentUrl: "u", destinationCountry: "JPN", recipientName: "B", addressLine1: "", postalCode: "", pageCount: 1, quantity: 1 });
      const cov = await coverage(e);
      expect(cov.printPartnerCount).toBe(2);
      expect(cov.printMailJobCount).toBe(2);
      expect(cov.jobsByDestinationCountry?.JPN).toBe(2);
    });
  });
});
