export type PrintMethod = "digital" | "offset" | "inkjet";
export type MailClass = "postal" | "registered" | "express" | "hybrid-mail";
export type ServiceLevel = "economy" | "standard" | "express";
export type ColorMode = "bw" | "color";

export interface PrintPartner {
  slug: string;
  partnerDid: string;
  displayName: string;
  country: string;
  region: "APAC" | "EMEA" | "NAM" | "LATAM" | "AFR";
  printMethods: PrintMethod[];
  mailClasses: MailClass[];
  supportsCertifiedMail: boolean;
  dailyCapacityPages: number;
  baseCostUsd: number;
  perPageUsd: number;
  serviceLevels: ServiceLevel[];
  downstreamActorDid?: string;
}

export interface QuoteInput {
  destinationCountry: string;
  pageCount: number;
  quantity: number;
  printMethod?: PrintMethod;
  mailClass?: MailClass;
  serviceLevel?: ServiceLevel;
  colorMode?: ColorMode;
}

export interface QuoteResult {
  partnerDid: string;
  partnerDisplayName: string;
  routeType: "local-post" | "hybrid-mail" | "postal-handoff";
  downstreamActorDid: string | null;
  estimatedProductionDays: number;
  estimatedDeliveryDays: number;
  estimatedTotalDays: number;
  estimatedCostUsd: number;
  currency: "USD";
}

export const PRINT_PARTNERS: PrintPartner[] = [
  {
    slug: "tokyo-printpost",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:tokyo-printpost",
    displayName: "Tokyo PrintPost Center",
    country: "JPN",
    region: "APAC",
    printMethods: ["digital", "offset", "inkjet"],
    mailClasses: ["postal", "registered", "express", "hybrid-mail"],
    supportsCertifiedMail: true,
    dailyCapacityPages: 180000,
    baseCostUsd: 6,
    perPageUsd: 0.035,
    serviceLevels: ["economy", "standard", "express"],
    downstreamActorDid: "did:web:yuubin.etzhayyim.com"
  },
  {
    slug: "singapore-hybrid-mail",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:singapore-hybrid-mail",
    displayName: "Singapore Hybrid Mail Hub",
    country: "SGP",
    region: "APAC",
    printMethods: ["digital", "inkjet"],
    mailClasses: ["postal", "express", "hybrid-mail"],
    supportsCertifiedMail: false,
    dailyCapacityPages: 95000,
    baseCostUsd: 7,
    perPageUsd: 0.04,
    serviceLevels: ["economy", "standard", "express"]
  },
  {
    slug: "berlin-direct-mail",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:berlin-direct-mail",
    displayName: "Berlin Direct Mail Works",
    country: "DEU",
    region: "EMEA",
    printMethods: ["digital", "offset"],
    mailClasses: ["postal", "registered", "hybrid-mail"],
    supportsCertifiedMail: true,
    dailyCapacityPages: 140000,
    baseCostUsd: 8,
    perPageUsd: 0.038,
    serviceLevels: ["economy", "standard"]
  },
  {
    slug: "chicago-print-fulfillment",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:chicago-print-fulfillment",
    displayName: "Chicago Print Fulfillment",
    country: "USA",
    region: "NAM",
    printMethods: ["digital", "offset", "inkjet"],
    mailClasses: ["postal", "registered", "express"],
    supportsCertifiedMail: true,
    dailyCapacityPages: 220000,
    baseCostUsd: 7,
    perPageUsd: 0.03,
    serviceLevels: ["economy", "standard", "express"]
  },
  {
    slug: "sao-paulo-postal-print",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:sao-paulo-postal-print",
    displayName: "Sao Paulo Postal Print",
    country: "BRA",
    region: "LATAM",
    printMethods: ["digital", "inkjet"],
    mailClasses: ["postal", "registered"],
    supportsCertifiedMail: true,
    dailyCapacityPages: 70000,
    baseCostUsd: 8,
    perPageUsd: 0.045,
    serviceLevels: ["economy", "standard"]
  },
  {
    slug: "johannesburg-gov-mail",
    partnerDid: "did:web:insatsu.etzhayyim.com:partner:johannesburg-gov-mail",
    displayName: "Johannesburg Gov Mail Press",
    country: "ZAF",
    region: "AFR",
    printMethods: ["digital", "offset"],
    mailClasses: ["postal", "registered", "hybrid-mail"],
    supportsCertifiedMail: true,
    dailyCapacityPages: 60000,
    baseCostUsd: 9,
    perPageUsd: 0.05,
    serviceLevels: ["economy", "standard"]
  }
];

const REGION_BY_COUNTRY: Record<string, PrintPartner["region"]> = {
  JPN: "APAC",
  SGP: "APAC",
  KOR: "APAC",
  AUS: "APAC",
  DEU: "EMEA",
  FRA: "EMEA",
  GBR: "EMEA",
  NLD: "EMEA",
  USA: "NAM",
  CAN: "NAM",
  MEX: "NAM",
  BRA: "LATAM",
  ARG: "LATAM",
  CHL: "LATAM",
  ZAF: "AFR",
  KEN: "AFR",
  NGA: "AFR"
};

export function regionForCountry(country: string): PrintPartner["region"] | null {
  return REGION_BY_COUNTRY[country.toUpperCase()] ?? null;
}

export function listSeedPartners(filters: {
  region?: string;
  country?: string;
  printMethod?: string;
  mailClass?: string;
} = {}): PrintPartner[] {
  return PRINT_PARTNERS.filter((partner) => {
    if (filters.region && partner.region !== filters.region) return false;
    if (filters.country && partner.country !== filters.country) return false;
    if (filters.printMethod && !partner.printMethods.includes(filters.printMethod as PrintMethod)) return false;
    if (filters.mailClass && !partner.mailClasses.includes(filters.mailClass as MailClass)) return false;
    return true;
  });
}

export function findSeedPartner(input: { slug?: string; actorDid?: string }): PrintPartner | null {
  if (input.slug) {
    const bySlug = PRINT_PARTNERS.find((partner) => partner.slug === input.slug);
    if (bySlug) return bySlug;
  }
  if (input.actorDid) {
    const byDid = PRINT_PARTNERS.find((partner) => partner.partnerDid === input.actorDid);
    if (byDid) return byDid;
  }
  return null;
}

function scorePartner(partner: PrintPartner, input: QuoteInput): number {
  const printMethod = input.printMethod ?? "digital";
  const mailClass = input.mailClass ?? "postal";
  const serviceLevel = input.serviceLevel ?? "standard";
  const region = regionForCountry(input.destinationCountry);

  if (!partner.printMethods.includes(printMethod)) return -1;
  if (!partner.mailClasses.includes(mailClass)) return -1;
  if (!partner.serviceLevels.includes(serviceLevel)) return -1;
  if (mailClass === "registered" && !partner.supportsCertifiedMail) return -1;

  let score = 10;
  if (partner.country === input.destinationCountry.toUpperCase()) score += 100;
  else if (region && partner.region === region) score += 50;
  if (partner.downstreamActorDid) score += 5;
  if (serviceLevel === "express" && partner.serviceLevels.includes("express")) score += 8;
  score += Math.min(20, Math.floor(partner.dailyCapacityPages / 10000));
  return score;
}

export function quotePrintMailJob(input: QuoteInput): QuoteResult | null {
  const destinationCountry = input.destinationCountry.toUpperCase();
  const printMethod = input.printMethod ?? "digital";
  const mailClass = input.mailClass ?? "postal";
  const serviceLevel = input.serviceLevel ?? "standard";
  const colorMode = input.colorMode ?? "bw";
  const ranked = PRINT_PARTNERS
    .map((partner) => ({ partner, score: scorePartner(partner, { ...input, destinationCountry, printMethod, mailClass, serviceLevel, colorMode }) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score);

  const selected = ranked[0]?.partner;
  if (!selected) return null;

  const pages = input.pageCount * input.quantity;
  const productionDays = pages > 5000 ? 2 : serviceLevel === "express" ? 0.5 : 1;
  const deliveryDays =
    selected.country === destinationCountry
      ? serviceLevel === "express" ? 1 : 2
      : selected.region === regionForCountry(destinationCountry)
        ? 3
        : 6;
  const serviceMultiplier = serviceLevel === "express" ? 1.45 : serviceLevel === "economy" ? 0.9 : 1;
  const colorMultiplier = colorMode === "color" ? 1.35 : 1;
  const registeredSurcharge = mailClass === "registered" ? 4.5 : mailClass === "express" ? 7 : 0;
  const estimatedCostUsd = Number(
    ((selected.baseCostUsd + pages * selected.perPageUsd + registeredSurcharge) * serviceMultiplier * colorMultiplier).toFixed(2)
  );

  return {
    partnerDid: selected.partnerDid,
    partnerDisplayName: selected.displayName,
    routeType:
      selected.downstreamActorDid && destinationCountry === "JPN"
        ? "postal-handoff"
        : mailClass === "hybrid-mail"
          ? "hybrid-mail"
          : "local-post",
    downstreamActorDid: selected.downstreamActorDid ?? null,
    estimatedProductionDays: productionDays,
    estimatedDeliveryDays: deliveryDays,
    estimatedTotalDays: productionDays + deliveryDays,
    estimatedCostUsd,
    currency: "USD"
  };
}
