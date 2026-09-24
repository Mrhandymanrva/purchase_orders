import { z } from "zod";
export const recordSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["qbo", "st"]),
  vendor: z.string().min(1),
  vendorMissing: z.boolean().optional(),
  vendorEvidence: z
    .object({
      source: z.literal("QuickBooks.PrivateNote"),
      text: z.string().min(1),
      rule: z.literal("qbo-lowes-store-v1"),
    })
    .optional(),
  amount: z.number().int().safe(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        !Number.isNaN(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v,
    ),
  reference: z.string().default(""),
  currency: z.literal("USD").default("USD"),
  description: z.string().default(""),
  account: z.string().default(""),
  accountId: z.string().optional(),
  technicianId: z.string().optional(),
  jobId: z.string().optional(),
  jobNumber: z.string().optional(),
  customerId: z.string().optional(),
  customerName: z.string().optional(),
  poTypeId: z.string().optional(),
  poStatus: z.string().optional(),
  inventoryLocationId: z.string().optional(),
  createdAt: z.string().optional(),
});
export type RecordItem = z.infer<typeof recordSchema> & {
  cardUser?: string;
  ownershipSource?: string;
  importedCardUser?: string;
  importedOwnershipSource?: string;
  cardPersonId?: string;
};
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Use a valid date",
  );
export const cardMappingSchema = z.object({
  id: z.string().optional(),
  accountId: z.string().trim().min(1).max(100),
  accountName: z.string().trim().max(150).optional(),
  cardUser: z.string().trim().min(2).max(100),
  personId: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().max(500).default(""),
});
// Legacy dates may remain in old snapshots/audits, but never limit ownership.
// New saves strip these fields and store one permanent mapping per card.
export type CardMapping = z.infer<typeof cardMappingSchema> & {
  id: string;
  from?: string;
  through?: string;
};
export const configSchema = z.object({
  automationMode: z.enum(["strict", "match-and-flag"]).default("strict"),
  windowDays: z.number().int().min(1).max(90),
  graceDays: z.number().int().min(0).max(30),
  lateDays: z.number().int().min(0).max(30),
  toleranceCents: z.number().int().min(0).max(1000),
  autoThreshold: z.number().min(70).max(100),
  ambiguityMargin: z.number().min(0).max(30),
  maxGroup: z.number().int().min(1).max(4),
  weights: z
    .object({
      vendor: z.number().min(0),
      amount: z.number().min(0),
      date: z.number().min(0),
      reference: z.number().min(0),
    })
    .refine(
      (v) => Object.values(v).reduce((a, b) => a + b, 0) === 100,
      "Weights must total 100",
    ),
});
export type Config = z.infer<typeof configSchema>;
export const defaults: Config = {
  automationMode: "strict",
  windowDays: 21,
  graceDays: 5,
  lateDays: 2,
  toleranceCents: 1,
  autoThreshold: 85,
  ambiguityMargin: 5,
  maxGroup: 1,
  weights: { vendor: 30, amount: 45, date: 15, reference: 10 },
};
export type Rule = {
  id: string;
  type: "alias" | "no-po";
  pattern: string;
  matchField?: "vendor" | "description";
  target: string;
  maxCents: number | null;
  approved: boolean;
  description: string;
};
export type Result = {
  id: string;
  status: string;
  charges: string[];
  pos: string[];
  vendor: string;
  amount: number;
  difference: number;
  date: string;
  score: number;
  reasons: string[];
  flags: string[];
  kind: string;
  categoryId?: string;
  categoryName?: string;
};
export type SpendCategory = { id: string; name: string; active: boolean };
export type Decision = {
  matchingMode?: "manual-many-to-one";
  resultId: string;
  fingerprint: string;
  action: "confirm" | "dismiss" | "categorize";
  categoryId?: string;
  categoryName?: string;
  reason: string;
  actor: string;
  at: string;
  charges: string[];
  pos: string[];
};
export type Audit = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: unknown;
  previousHash: string;
  hash: string;
};
export type State = {
  revision: number;
  records: RecordItem[];
  config: Config;
  rules: Rule[];
  decisions: Decision[];
  spendCategories?: SpendCategory[];
  audit: Audit[];
  lastSync: string | null;
  mode: "demo" | "live";
  cardAssignments?: Record<string, string>;
  cardMappings?: CardMapping[];
  directory?: Directory;
  quickbooks?: QuickBooksSettings;
  serviceTitan?: ServiceTitanSettings;
  vanStockTypeIds?: string[];
  coverage?: { chargesFrom: string; posFrom: string; through: string };
};
export type ServiceTitanSettings = {
  tenantId: string;
  environment: "production" | "integration";
  businessUnits: { id: string; name: string; active: boolean }[];
  discoveredAt: string;
  businessUnitIds?: string[];
};
export type QuickBooksAccount = {
  id: string;
  name: string;
  active: boolean;
  parentId?: string;
  subAccount: boolean;
};
export type QuickBooksSettings = {
  realm: string;
  companyName: string;
  environment: "production" | "sandbox";
  clientFingerprint: string;
  connectedAt: string;
  accounts: QuickBooksAccount[];
  discoveredAt?: string;
  parentAccountId?: string;
  accountIds: string[];
};
export type Directory = {
  accounts: { id: string; name: string; active: boolean; parentId?: string }[];
  people: {
    id: string;
    sourceId: string;
    name: string;
    kind: "technician" | "employee";
    active: boolean;
  }[];
  poTypes: { id: string; name: string; active: boolean }[];
  syncedAt: string;
};
export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  );
