/**
 * Porter's fixed service taxonomy.
 *
 * This is the contract the agent reasons over, so adapters map into it rather
 * than inventing categories. An adapter that cannot map a provider category
 * reports it as unmapped; the service stays searchable by text but is never
 * auto-matched to a category. Guessing would make ranking meaningless.
 *
 * v1 is beauty and home services only. Medical, health, legal and financial
 * categories are deliberately excluded: the Muse Connector Policies prohibit
 * "practising regulated professions without authorization", and health-adjacent
 * bookings also engage the prohibition on inferring or acting on sensitive
 * attributes. See docs/muse-requirements.md section 6A.7.
 */
export const TAXONOMY_VERSION = "1.0.0";

export const SERVICE_CATEGORIES = [
  // Beauty and wellness
  "beauty.haircut",
  "beauty.hair.color",
  "beauty.hair.styling",
  "beauty.nails.manicure",
  "beauty.nails.pedicure",
  "beauty.barber",
  "beauty.waxing",
  "beauty.massage",
  "beauty.facial",
  "beauty.makeup",
  "beauty.lashes",

  // Home services
  "home.plumbing.leak",
  "home.plumbing.drain",
  "home.plumbing.install",
  "home.hvac.repair",
  "home.hvac.maintenance",
  "home.hvac.install",
  "home.electrical.repair",
  "home.electrical.install",
  "home.cleaning.standard",
  "home.cleaning.deep",
  "home.cleaning.moveout",
  "home.handyman.general",
  "home.appliance.repair",
  "home.pest.control",
  "home.landscaping.lawn",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(SERVICE_CATEGORIES);

export function isServiceCategory(value: string): value is ServiceCategory {
  return CATEGORY_SET.has(value);
}

/**
 * Categories that normally need a site visit or job description before a price
 * can be given. Search results for these lead with `get_quote`, not a slot.
 */
export const QUOTE_REQUIRED_CATEGORIES: ReadonlySet<ServiceCategory> = new Set([
  "home.plumbing.leak",
  "home.plumbing.install",
  "home.hvac.repair",
  "home.hvac.install",
  "home.electrical.repair",
  "home.electrical.install",
  "home.appliance.repair",
]);

/** Top-level domain of a category, e.g. "beauty.haircut" -> "beauty". */
export function categoryDomain(category: ServiceCategory): string {
  return category.split(".")[0] ?? "";
}

/**
 * Resolve a loose, user-phrased category to a taxonomy entry.
 *
 * Accepts an exact category, a domain prefix match, or a small set of common
 * synonyms. Returns every plausible match rather than picking one, so the
 * caller can search broadly. Unknown input yields an empty list, never a guess.
 */
export function resolveCategory(input: string): ServiceCategory[] {
  const q = input.trim().toLowerCase();
  if (q.length === 0) return [];
  if (isServiceCategory(q)) return [q];

  const prefixed = SERVICE_CATEGORIES.filter((c) => c === q || c.startsWith(`${q}.`));
  if (prefixed.length > 0) return [...prefixed];

  const synonyms: Record<string, ServiceCategory[]> = {
    haircut: ["beauty.haircut", "beauty.barber"],
    hair: ["beauty.haircut", "beauty.hair.color", "beauty.hair.styling"],
    barber: ["beauty.barber", "beauty.haircut"],
    salon: ["beauty.haircut", "beauty.hair.color", "beauty.hair.styling"],
    nails: ["beauty.nails.manicure", "beauty.nails.pedicure"],
    manicure: ["beauty.nails.manicure"],
    pedicure: ["beauty.nails.pedicure"],
    massage: ["beauty.massage"],
    facial: ["beauty.facial"],
    plumber: ["home.plumbing.leak", "home.plumbing.drain", "home.plumbing.install"],
    plumbing: ["home.plumbing.leak", "home.plumbing.drain", "home.plumbing.install"],
    leak: ["home.plumbing.leak"],
    drain: ["home.plumbing.drain"],
    ac: ["home.hvac.repair", "home.hvac.maintenance"],
    "air conditioning": ["home.hvac.repair", "home.hvac.maintenance"],
    hvac: ["home.hvac.repair", "home.hvac.maintenance", "home.hvac.install"],
    heating: ["home.hvac.repair", "home.hvac.maintenance"],
    electrician: ["home.electrical.repair", "home.electrical.install"],
    electrical: ["home.electrical.repair", "home.electrical.install"],
    cleaner: ["home.cleaning.standard", "home.cleaning.deep"],
    cleaning: ["home.cleaning.standard", "home.cleaning.deep", "home.cleaning.moveout"],
    handyman: ["home.handyman.general"],
    appliance: ["home.appliance.repair"],
    pest: ["home.pest.control"],
    lawn: ["home.landscaping.lawn"],
    landscaping: ["home.landscaping.lawn"],
  };

  return synonyms[q] ? [...synonyms[q]] : [];
}
