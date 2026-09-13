import type { State } from "./domain";

export class ServiceTitanSetupError extends Error {}

export function configuredST(state?: State): {
  tenantId: string;
  environment: "production" | "integration";
  businessUnitIds: string[];
} {
  const environment = process.env.ST_ENV || "integration";
  if (environment !== "production" && environment !== "integration")
    throw new ServiceTitanSetupError(
      "Choose a valid ServiceTitan environment in Railway.",
    );
  const tenantId = process.env.ST_TENANT_ID?.trim() || "";
  const saved = state?.serviceTitan;
  if (
    saved &&
    (saved.environment !== environment || saved.tenantId !== tenantId)
  )
    throw new ServiceTitanSetupError(
      "ServiceTitan tenant or environment changed. Restore the original connection settings for this workspace.",
    );
  return {
    tenantId,
    environment,
    businessUnitIds:
      saved?.businessUnitIds ??
      (process.env.ST_BUSINESS_UNIT_IDS || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
  };
}
