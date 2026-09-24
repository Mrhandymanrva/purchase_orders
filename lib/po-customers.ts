import { z } from "zod";
import type { RecordItem } from "./domain";
import { getJSON, required } from "./integration-transport";

const idSchema = z
  .union([z.string().min(1), z.number().int().safe()])
  .transform(String);
const jobSchema = z.object({
  id: idSchema,
  jobNumber: z.string().nullish(),
  customerId: idSchema.nullish(),
});
const customerSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
});

// Fetch only entities referenced by imported POs, in bounded batches. Do not
// import contact details, addresses or unrelated customer records.
async function related<T extends { id: string }>(
  ids: string[],
  resource: "jpm" | "crm",
  kind: "jobs" | "customers",
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  token: string,
  fetcher: typeof fetch,
) {
  const result = new Map<string, T>();
  const base =
    process.env.ST_ENV === "production"
      ? "https://api.servicetitan.io"
      : "https://api-integration.servicetitan.io";
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const params = new URLSearchParams({
        ids: batch.join(","),
        page: String(page),
        pageSize: "50",
        includeTotal: "true",
      });
      if (kind === "customers") params.set("active", "Any");
      const response = await getJSON(
        `${base}/${resource}/v2/tenant/${encodeURIComponent(required("ST_TENANT_ID"))}/${kind}?${params}`,
        {
          Authorization: `Bearer ${token}`,
          "ST-App-Key": required("ST_APP_KEY"),
        },
        fetcher,
      );
      const data = z
        .object({ data: z.array(schema), hasMore: z.boolean() })
        .parse(response);
      for (const row of data.data) {
        if (!batch.includes(row.id) || result.has(row.id))
          throw Error(
            `ServiceTitan ${kind} lookup returned unexpected or duplicate IDs`,
          );
        result.set(row.id, row);
      }
      if (!data.hasMore) {
        complete = true;
        break;
      }
    }
    if (!complete)
      throw Error(`ServiceTitan ${kind} lookup exceeded pagination limit`);
  }
  return result;
}

export async function enrichPOCustomers(
  records: RecordItem[],
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const ids = [
    ...new Set(records.map((p) => p.jobId).filter((id): id is string => !!id)),
  ];
  if (!ids.length) return records;
  try {
    const jobs = await related(ids, "jpm", "jobs", jobSchema, token, fetcher);
    const customerIds = [
      ...new Set(
        [...jobs.values()]
          .map((j) => j.customerId)
          .filter((id): id is string => !!id && id !== "0"),
      ),
    ];
    const customers = await related(
      customerIds,
      "crm",
      "customers",
      customerSchema,
      token,
      fetcher,
    );
    return records.map((p) => {
      const job = p.jobId ? jobs.get(p.jobId) : undefined;
      const jobNumber = job?.jobNumber;
      const customerId = job?.customerId;
      const customerName = customerId
        ? customers.get(customerId)?.name
        : undefined;
      return {
        ...p,
        ...(jobNumber ? { jobNumber } : {}),
        ...(customerId ? { customerId } : {}),
        ...(customerName ? { customerName } : {}),
      };
    });
  } catch (error) {
    throw Error(
      `ServiceTitan customer/job lookup failed. Check Jobs and Customers read access. ${error instanceof Error ? error.message : "Unknown lookup error"}`,
    );
  }
}
