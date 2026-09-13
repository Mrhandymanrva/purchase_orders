export type SetupCheck = {
  setting: string;
  label: string;
  configured: boolean;
  syncOnly?: boolean;
};
export type IntegrationSetup = {
  sources: {
    name: string;
    environment: string;
    checks: SetupCheck[];
  }[];
  directoryReady: boolean;
  syncReady: boolean;
};

// Only fixed labels and booleans leave the server. Never return env values.
export function integrationSetup(
  env: Record<string, string | undefined>,
  storedQuickBooksToken = false,
  today = new Date().toISOString().slice(0, 10),
): IntegrationSetup {
  const present = (key: string) => Boolean(env[key]?.trim());
  const ids = (key: string) =>
    Boolean(env[key]?.split(",").some((id) => id.trim()));
  const check = (
    setting: string,
    label: string,
    syncOnly = false,
  ): SetupCheck => ({
    setting,
    label,
    configured: present(setting),
    syncOnly,
  });
  const stEnv = env.ST_ENV || "integration";
  const qbEnv = env.QBO_ENV || "sandbox";
  const from = env.SYNC_FROM || "";
  const date = new Date(from);
  const sources = [
    {
      name: "ServiceTitan",
      environment:
        stEnv === "production"
          ? "Production"
          : stEnv === "integration"
            ? "Integration / test"
            : "Invalid environment",
      checks: [
        {
          setting: "ST_ENV",
          label: "Environment",
          configured: ["production", "integration"].includes(stEnv),
        },
        check("ST_TENANT_ID", "Tenant ID"),
        check("ST_CLIENT_ID", "Client ID"),
        check("ST_CLIENT_SECRET", "Client secret"),
        check("ST_APP_KEY", "Application key"),
        {
          ...check("ST_BUSINESS_UNIT_IDS", "Richmond business unit IDs", true),
          configured: ids("ST_BUSINESS_UNIT_IDS"),
        },
      ],
    },
    {
      name: "QuickBooks Online",
      environment:
        qbEnv === "production"
          ? "Production"
          : qbEnv === "sandbox"
            ? "Sandbox / test"
            : "Invalid environment",
      checks: [
        {
          setting: "QBO_ENV",
          label: "Environment",
          configured: ["production", "sandbox"].includes(qbEnv),
        },
        check("QBO_CLIENT_ID", "Client ID"),
        check("QBO_CLIENT_SECRET", "Client secret"),
        check("QBO_REALM_ID", "Authorized company ID"),
        {
          setting: "QBO_REFRESH_TOKEN",
          label: "Company authorization (initial or stored token)",
          configured: present("QBO_REFRESH_TOKEN") || storedQuickBooksToken,
        },
        {
          setting: "QBO_PARENT_CC_ACCOUNT_ID or QBO_CARD_ACCOUNT_IDS",
          label: "Parent card account or child account IDs for dropdowns",
          configured:
            present("QBO_PARENT_CC_ACCOUNT_ID") || ids("QBO_CARD_ACCOUNT_IDS"),
        },
        {
          ...check(
            "QBO_CARD_ACCOUNT_IDS",
            "Child card account IDs to import",
            true,
          ),
          configured: ids("QBO_CARD_ACCOUNT_IDS"),
        },
      ],
    },
    {
      name: "Import settings",
      environment: "Workspace",
      checks: [
        {
          setting: "TOKEN_ENCRYPTION_KEY",
          label: "Token encryption key (32 bytes, base64)",
          configured:
            Buffer.from(env.TOKEN_ENCRYPTION_KEY || "", "base64").length === 32,
        },
        {
          setting: "SYNC_FROM",
          label: "Import start date (YYYY-MM-DD, today or earlier)",
          configured:
            /^\d{4}-\d{2}-\d{2}$/.test(from) &&
            !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === from &&
            from <= today,
          syncOnly: true,
        },
      ],
    },
  ];
  const checks = sources.flatMap((source) => source.checks);
  return {
    sources,
    directoryReady: checks
      .filter((c) => !c.syncOnly)
      .every((c) => c.configured),
    syncReady: checks.every((c) => c.configured),
  };
}

export class IntegrationSetupError extends Error {
  constructor(setup: IntegrationSetup, operation: "sync" | "directory") {
    const missing = setup.sources
      .flatMap((s) => s.checks)
      .filter((c) => !c.configured && (operation === "sync" || !c.syncOnly))
      .map((c) => c.setting);
    const managed = [
      "QBO_REALM_ID",
      "QBO_REFRESH_TOKEN",
      "QBO_CARD_ACCOUNT_IDS",
      "QBO_PARENT_CC_ACCOUNT_ID or QBO_CARD_ACCOUNT_IDS",
    ];
    const variables = missing.filter((key) => !managed.includes(key));
    super(
      `Integration setup incomplete. ${variables.length ? `Add or correct these Railway variables: ${variables.join(", ")}. ` : ""}${missing.some((key) => managed.includes(key)) ? "Use Connect QuickBooks and select the card accounts in Integrations. " : ""}Open Integrations for the setup checklist. Enter secrets in Railway only.`,
    );
    this.name = "IntegrationSetupError";
  }
}
