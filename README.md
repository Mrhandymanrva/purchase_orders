# Richmond purchase reconciliation

Next.js / React + Node / TypeScript + PostgreSQL MVP for posted QuickBooks credit-card purchases versus ServiceTitan purchase orders. Includes an interactive seeded Richmond workspace, deterministic matching, explicit human review, individual card-user reporting, and Railway deployment files.

**Live readiness:** local validation does not validate your tenant's API permissions, PO total semantics, identity fields, or accounting data. Complete the go-live checklist below before relying on live results. No live credentials are included and no cloud deployment has been performed.

## Run the sample workspace

Requires Node.js 22 and npm. From this directory:

```sh
npm ci
```

Copy `.env.example` to `.env.local`, leave `DEMO_MODE=true`, then:

```sh
npm run dev
```

Open http://127.0.0.1:3000. The sample uses a fixed as-of date of September 13, 2026. It includes split payments, combined POs, a refund, duplicate charges, a late PO, missing items, an amount mismatch, a partial match, and rule suggestions. Sample card-user names are fictional. Demo changes are in process memory and reset on restart; demo bypass is automatically disabled in production.

## Main workflow and individual reporting

1. Use **Card user filter** to select an individual or Unassigned. KPI totals follow the person and date range; status and search filters narrow the table. Variance is the full reconciliation-group difference, not a personal liability allocation.
2. Open a vendor row. The detail panel shows the card user → PO link, source records, score evidence, and remaining difference. Confidence is a policy score, not a statistical probability.
3. In **Card assignments**, edit all mappings in one grid using QuickBooks subaccount and ServiceTitan person dropdowns, effective dates, and a reason. Save each changed row. Source IDs distinguish duplicate account and employee names. Per-charge manual corrections take precedence, then dated subaccount assignments, then imported ownership, then Unassigned. Reconciled POs follow their actual card users.
4. For a shared card or missing identity, enter the actual card user and assignment evidence on the specific charge. This produces an audit event and persists across future syncs. Correct an assignment by saving a replacement with a reason. Reassignment invalidates any manual reconciliation that depended on the old source fingerprint.
5. **Export report** downloads a CSV using current person, date, status, and search filters. It contains one line per card charge, its actual user, ownership source, signed amount, PO IDs, proposed/reconciled link state, status, and score. It does not repeat the full PO amount for each user; shared-PO totals therefore are not double-counted. Orphan POs appear with zero card spend only in the all-individuals report. User-provided strings are escaped against spreadsheet formula injection.
6. Confirm or dismiss a result with a reason. To override the proposed PO, enter exact source PO IDs, comma separated. Live IDs use `ST:<id>`; sample IDs use `PO-2041` etc. Another manual decision cannot reserve those records again. Manual decisions affect this app only.
7. In **Rules & scoring**, edit thresholds or propose a vendor alias / No-PO-Required rule. Proposed rules are inert until **Approve rule** is explicitly clicked. Audit history records the separate proposal and approval.

Richmond's confirmed structure is one parent credit-card account with individual card subaccounts. Configure `QBO_CARD_ACCOUNT_IDS` with the child IDs. The app sums each child's actual Purchase records once; it does not import parent statement balances as additional purchases. Set `QBO_PARENT_CC_ACCOUNT_ID` to protect the parent from being mapped to one employee. Charges posted directly to the parent are outside a child-only allowlist and must be corrected or separately reviewed in QuickBooks.

Assignments use inclusive start/end dates. End the previous assignment before adding a new person to a reused card. Overlapping periods are rejected. Editing a date range restores imported ownership outside that range; audited per-charge overrides remain intact. Assignment changes invalidate manual reconciliations whose owner evidence changed. Individual CSV exports include the originating subaccount name and ID. UI mappings persist in PostgreSQL with the rest of the workspace; no new migration is needed.

## PostgreSQL

Start a disposable local database using `docker compose up -d postgres`, or provision PostgreSQL 16+ elsewhere. Set `DATABASE_URL` in `.env.local` and run:

```sh
npm run db:migrate
```

For a disposable database only, set `ALLOW_SEED=true` before `npm run db:seed`. Seeding refuses a workspace with existing records or audit events. Do not seed a live tenant database. To use the PostgreSQL-backed seeded workspace, set `DEMO_MODE=false` and configure authentication. Its workspace mode remains sample; sync reruns the sample rather than importing live data.

The migration initializes one live Richmond workspace. A singleton JSONB aggregate deliberately keeps policy, source snapshot, assignments and decisions in one locked transaction. Separate PostgreSQL tables store immutable audit events and encrypted OAuth tokens. This is a bounded branch MVP, not a multi-tenant data warehouse. `SELECT … FOR UPDATE` plus expected revision prevents lost updates across replicas. Fetching both external sources completes before committing a new snapshot; an adapter error leaves the previous snapshot intact.

The SQL audit trigger rejects UPDATE, DELETE and TRUNCATE. SHA-256 events use canonical JSON with a previous-event hash. This detects accidental or ordinary-operator tampering; a database owner can replace the table or trigger. Keep backups and an independently protected audit export for stronger tamper evidence. Use a migration owner and restricted runtime role in production; the runtime needs SELECT/UPDATE on app_state, SELECT/INSERT on audit_events, sequence USAGE, and SELECT/INSERT/UPDATE on oauth_tokens.

## Environment variables

All values are server-only; do not add `NEXT_PUBLIC_` prefixes or commit secrets.

| Variable                                         | Purpose                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`                                      | `true` enables in-memory sample mode only outside production. Use `false` for PostgreSQL.                                                                            |
| `DATABASE_URL`                                   | PostgreSQL connection string. Required outside sample mode.                                                                                                          |
| `PGSSL`                                          | `true` enables certificate-verified TLS. Use Railway private networking as configured by your database. Never disable certificate verification to fix TLS errors.    |
| `APP_ORIGIN`                                     | Exact browser origin, e.g. `https://your-app.up.railway.app`. POST origin must match.                                                                                |
| `APP_USER`                                       | Named Richmond operator account, used as audit actor. ASCII username for Basic authentication.                                                                       |
| `APP_PASSWORD`                                   | At least 20 characters, unique random password; required outside sample mode.                                                                                        |
| `ST_ENV`                                         | `integration` by default; explicitly set `production` for live tenant.                                                                                               |
| `ST_TENANT_ID`                                   | Authorized tenant ID.                                                                                                                                                |
| `ST_CLIENT_ID`, `ST_CLIENT_SECRET`, `ST_APP_KEY` | ServiceTitan application credentials. Restrict application resource permissions to reads.                                                                            |
| `ST_BUSINESS_UNIT_IDS`                           | Comma-separated Richmond business units. Required; excludes other branches.                                                                                          |
| `QBO_ENV`                                        | `sandbox` by default; explicitly set `production` for live company.                                                                                                  |
| `QBO_REALM_ID`                                   | Authorized QuickBooks company ID.                                                                                                                                    |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`             | Intuit app credentials.                                                                                                                                              |
| `QBO_REFRESH_TOKEN`                              | Initial refresh token from an authorized OAuth connection. Rotated tokens are encrypted in PostgreSQL.                                                               |
| `TOKEN_ENCRYPTION_KEY`                           | Base64-encoded 32 random bytes for AES-256-GCM. Back it up securely; changing it requires token reconnection.                                                        |
| `QBO_CARD_ACCOUNT_IDS`                           | Comma-separated Richmond CHILD card subaccount IDs. Required.                                                                                                        |
| `QBO_PARENT_CC_ACCOUNT_ID`                       | Parent CC account ID; blocks assigning the parent to one person.                                                                                                     |
| `QBO_CARDHOLDERS_JSON`                           | Verified individual account mapping, e.g. `{"81":"Alex Morgan","82":"Chris Parker"}`. Never assign a shared parent account to one person.                            |
| `QBO_CARDHOLDER_FIELD`                           | Optional exact Purchase CustomField name containing actual card-user identity. Overrides the server fallback mapping; verified dated UI assignments take precedence. |
| `SYNC_FROM`                                      | Fixed inclusive QuickBooks date boundary, `YYYY-MM-DD`. Current UTC day is the end boundary.                                                                         |
| `PORT`                                           | Railway-injected listening port; local default 3000.                                                                                                                 |

Generate an encryption key locally with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and store it in Railway variables or a secret manager. Do not paste live secrets into app fields, source control, or reports.

Production authentication is a single named operator behind HTTPS, suitable for a restricted Richmond MVP. It is not an SSO/RBAC or per-employee login system. Individual **card-user reporting** is separate from login identity. Put the app behind your organization's access proxy before sharing with additional operators, or extend authentication with individual accounts. `/api/health` is intentionally public and contains no business data. Browser Basic-auth credentials are cleared by closing the browser session.

## Read-only integration boundary

- ServiceTitan uses client-credentials authentication, then GETs `inventory/v2/tenant/{tenant}/vendors` and `purchase-orders`. Expected PO fields: `id`, `vendorId`, `number`, `date`, `createdOn`, `total`, `status`, and `businessUnitId`. Pending and canceled POs are excluded. Confirm that `total` includes all applicable tax/freight in your tenant. Date-based late detection uses `createdOn`, so backdating the PO cannot conceal late entry.
- QuickBooks uses the Accounting API `Purchase` query with page size 1000. It retains `PaymentType=CreditCard`, allowed card accounts and USD. Purchases here are accounting transactions, not pending bank-feed lines. `Credit=true` produces a negative amount. A purchase document number is not treated as a PO number; use a configured PO custom field or a `PO-123` memo reference.
- Only fixed allowlisted HTTPS resource hosts and GET methods are used. OAuth token POSTs are the only external writes, and do not modify financial records. Intuit's Accounting OAuth scope is broader than read-only; this application enforces read-only use in its resource adapter. Provision the least access available.
- QuickBooks access tokens refresh automatically; the latest refresh token is encrypted and persisted under a PostgreSQL advisory lock. An expired/revoked token requires a new authorized OAuth connection. Initial OAuth consent/callback onboarding is not implemented; provision an authorized refresh token out of band. Remote token rotation followed by a failed local commit can require reconnection.
- Adapters validate response shapes, paginate, apply timeouts, retry 429/5xx up to three times, and reject redirects. They do not log token values or response bodies. Unknown vendor names, non-USD amounts, fractional cents, malformed records, and pagination truncation fail the sync.
- ServiceTitan POs are read back to 90 days before `SYNC_FROM` to catch older related POs. This means older orphan POs can appear; use the screen dates for the reporting period. No records are fetched after the current date. Keep `SYNC_FROM` fixed for stable history; narrowing it removes records from the active snapshot and invalidates dependent manual decisions, with prior evidence retained in the audit.
- This version reads POs, not ServiceTitan's separate Returns API. Negative PO records are supported when present; otherwise card refunds remain unallocated credit exceptions for explicit review. It never matches a refund against a positive PO or silently nets opposite signs.

References: [ServiceTitan inventory API](https://developer.servicetitan.io/api-details/#api=tenant-inventory-v2), [QuickBooks Purchase](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase), [Intuit Credit property](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/60774b37-3fa3-9d95-a1bb-f3931a86bbc6.htm).

## Matching behavior

`lib/engine.ts` is a pure deterministic function. There is no LLM dependency. Integer cents, normalized exact vendors, USD, same sign and a bounded date window are hard constraints. Alias rules are explicit and exact after punctuation normalization; there is no fuzzy merchant guessing.

Default score: vendor 30 + amount 45 + date proximity up to 15 + explicit PO reference 10. Weights must sum to 100. Automatic threshold is 85, date window 21 days, grace period 5 days, late threshold 2 days, and amount tolerance 1 cent. An amount mismatch, partial match, duplicate, conflicting reference, ambiguous allocation or late PO cannot auto-confirm regardless of score. Score and reasons remain available to the reviewer.

Exact group sums support 1:1, 1:many and many:1; many:many is out of scope. Maximum group size defaults to 3, configurable up to 4. Eligible pools over 14 disable automatic grouping for the affected record. A snapshot is capped at 2,000 records and 20,000 generated candidates; exceeding a cap fails closed. This conservative, deterministic ranking is not a globally optimal combinatorial solver. Competing allocations near the winning score become review items. A source record appears in at most one result, and manual reservations take precedence.

No-PO-Required rules require approval, an exact vendor and a positive charge within the cap; they never hide suspected duplicates or refunds. Manual decisions contain complete source fingerprints and are automatically ignored after source changes. Rerun audit events retain the source fingerprint, policy, approved rule IDs, as-of date, engine version, invalidations and complete results.

## Assignment grid and source dropdowns

The grid shows every saved assignment period plus an editable row for each unmapped active card subaccount. **Add assignment period** creates another dated row. Inline edits are highlighted until **Save row** succeeds; other unsaved rows remain in place. Date overlaps are rejected, and every save records before/after evidence in the audit log. No new PostgreSQL migration is required.

**Refresh ST / QB dropdowns** loads a read-only source directory independently of transaction sync. Live sync refreshes it too. The ServiceTitan application needs GET access to Settings Technicians, Settings Employees and Inventory Purchase Order Types in addition to POs/vendors. The QuickBooks connection needs Accounting Account query access. Only source IDs, names, entity kinds and active status are retained for people; payroll, contact and other returned fields are discarded. Inactive entries remain available for existing history but cannot be newly assigned. Demo dropdowns use fictional source directories.

QuickBooks dropdowns include Credit Card descendants under `QBO_PARENT_CC_ACCOUNT_ID`, including cards without transactions. If no parent is configured, only child accounts in `QBO_CARD_ACCOUNT_IDS` are included. The transaction import allowlist remains separate: mapping a new child does not automatically expand source transaction scope.

Directory schema references: [ServiceTitan Settings schema](https://developer.servicetitan.io/api/docs/apis/tenant-settings-v2), [ServiceTitan Inventory schema](https://developer.servicetitan.io/api/docs/apis/tenant-inventory-v2), [Intuit Account ParentRef](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/57c1fa34-cecf-9242-2def-d376b244441b.htm).

## Technician scorecards

Open **Technician scorecards**. Choose Week, Month, QTR or Year, the reporting year, and an individual interval/person. All four metrics, the technician table, source evidence and scorecard export use that same period. Weeks use ISO Monday–Sunday boundaries; months, quarters and years use calendar boundaries. The source date, not browser timezone, decides inclusion.

- **Total card spend:** signed QBO posted card Purchase amounts by purchase date. Credits reduce spend.
- **Total PO:** signed eligible imported ST PO totals by PO date, including POs without charges. Canceled/pending POs remain excluded by the existing adapter policy. PO totals include source tax/shipping.
- **Spend / PO:** net card spend divided by net PO dollars; shown only with a positive PO denominator. It is a period comparison, not a match rate or employee liability.
- **Van Stock:** signed PO dollars and count for POs explicitly labeled **VAN STOCK** or **VS** in ST; a subset of Total PO. Rule `st-explicit-label-v1` recognizes an exact PO type name, or a leading label in the PO number (`number`) or summary (`summary`). Examples: `VAN STOCK: supplies`, `[VS] truck restock`, `VS-1044`. Case and extra whitespace are ignored. Whole leading labels only: `VS123`, `Van stockroom`, `Not VAN STOCK`, and a mid-sentence `vs` do not match. This rule works immediately with no additional configuration. Additional ST PO type IDs can be approved in **Van Stock definition**, with a reason and audit entry; they do not disable the fixed label rule. Source details show the label and field that triggered classification; CSV exports include the rule version. This metric measures purchased stock, not on-hand inventory valuation. The integration reads existing labels and never edits ST POs.

For PO attribution, a reconciled match (`Matched` or `Confirmed`) with one card user takes precedence. Otherwise the source PO's `technicianId` supplies the technician. A reconciled PO paid by several card users appears once under Shared card users; unassigned POs remain visible. Proposed matches never reattribute POs. Charges/POs outside the selected period can supply an existing reconciliation link without contributing dollars in that period. POs with no recognized label and an unavailable type are flagged as unclassified and may make Van Stock totals incomplete. Click a person or **Show source details** to inspect each included source record and its attribution basis.

The date controls filter the imported snapshot; they do not fetch older history on demand. Set `SYNC_FROM` early enough for the requested reporting year and complete a sync, subject to the documented 2,000-record MVP snapshot cap. The UI and CSV state imported date coverage and mark partial periods. Annual totals must not be treated as complete when coverage is partial. Directory/scorecard settings and source coverage persist in PostgreSQL and survive restart; demo state remains temporary.

## Upload cardholder mappings

Open **Card assignments → Upload or update mappings from Excel / CSV**. Download the Excel template, fill the `Card mappings` tab, and upload `.xlsx` or `.csv` (up to 1,000 rows / 2 MB). Review the before/after table, then select **Apply reviewed import**. The Instructions tab explains each column; the blank template never creates assignments. Current-mapping exports include `ST Person ID`; retain it for the same person, or select the new identity when reassigning a card. Conflicting names and IDs are rejected.

Required fields are **Subaccount ID**, **Card user**, and **Effective from**. IDs identify the QuickBooks child accounts, not the parent account or full card number. IDs are text so leading zeros remain intact. Dates accept Excel dates, `YYYY-MM-DD`, or US `M/D/YYYY`. A known, unique subaccount name may replace an ID after sync; new explicit IDs can be loaded before the first sync. Verify those IDs against QuickBooks. Uploading mappings does not change `QBO_CARD_ACCOUNT_IDS`; configure that source import scope separately.

Repeat uploads use Mapping ID when provided, otherwise Subaccount ID + Effective from. Same-period corrections retain the assignment ID. Identical rows remain unchanged; omitted cards stay mapped. A new later start date creates a new assignment and closes the preceding open assignment the day before, preserving historical attribution. Existing explicitly ended periods are never silently shortened. A blank end date retains an existing end date; use the manual edit form to reopen a period. **Export current mappings** provides stable Mapping IDs for precise corrections, especially changes to start dates. Do not reuse an existing Mapping ID for a new reassignment period; leave it blank on that new row.

Duplicate rows, overlapping dates, invalid dates, unknown Mapping IDs, ambiguous names, and the configured parent CC account block the entire import. Formula cells must be pasted as values. Files are parsed in memory with ZIP expansion limits and are not retained. The preview is signed, expires after 15 minutes, and is bound to the current workspace revision. If another action changes the workspace, preview again. Applying uses the PostgreSQL transaction and records the file hash, reason, before/after changes and affected charges in the audit log. Individual charge overrides take precedence. Source APIs remain read-only.

The XLSX reader handles both standard Excel files and prefixed SpreadsheetML from OpenXML generators. This includes a compatibility normalization for [ExcelJS issue 1437](https://github.com/exceljs/exceljs/issues/1437), with cell text and relationship IDs preserved. The ExcelJS UUID dependency is overridden to 11.1.1 to avoid the older dependency advisory; keep this override until upstream updates it.

## Test and build

```sh
npm test
npm run typecheck
npm run build
```

Tests exercise all match types, ambiguity, duplicate allocation, grouping caps, cents, credits, grace/late logic, rule approval, manual invalidation, read-only pagination/retries, ownership mapping, individual CSV reporting, encryption, PostgreSQL persistence, rollback and immutable audit triggers. Database integration tests execute real PostgreSQL engine semantics through PGlite (WASM); they do not replace testing your Railway PostgreSQL connection, TLS and role permissions.

The Dockerfile uses Next standalone output with Node 22 and a non-root runtime user. `.github/workflows/ci.yml` tests and builds on Linux. Local sample mode runs with `npm run dev`; `npm start` is production mode and requires authentication and PostgreSQL.

`node scripts/smoke-demo.cjs` runs HTTP checks against an already-running local sample server. It verifies sample mode before making test-only assignments and reconciliation runs. The PostCSS override in `package.json` pins 8.5.28 to address vulnerabilities in Next 15's older bundled version; retain the override until an upgraded Next version ships a patched dependency. The dependency audit was clear after this update.

On sync, repeated missing-PO purchases on at least three distinct dates can generate a deterministic No-PO-Required suggestion. Recurrence is only a review signal: these suggestions remain inactive until explicitly approved.

## Railway deployment

1. Put this app directory at the repository root, or select it as the Railway service root. Add a PostgreSQL service in the same project.
2. Configure `DATABASE_URL` as a reference to the PostgreSQL service. Set `DEMO_MODE=false`, `APP_USER`, a strong `APP_PASSWORD`, `APP_ORIGIN`, and the integration variables above. Keep secrets in Railway Variables, not build arguments.
3. Railway detects `Dockerfile`; `railway.json` runs `node scripts/migrate.cjs` as a pre-deploy command. The migration is idempotent and never seeds production. For separated database roles, run the migration under a controlled owner job and give the web service restricted runtime credentials.
4. Generate a Railway HTTPS domain and set `APP_ORIGIN` to that exact origin. The runtime listens on injected `PORT`. Health checks use `/api/health` and verify database/schema and authentication configuration.
5. Deploy, inspect logs, authenticate, and perform sandbox validation before setting source environments to production. Empty live data is expected until a successful sync.
6. Enable PostgreSQL backups and test a restore including OAuth ciphertext and its separately protected encryption key. Keep the previous deployment available for rollback; do not reverse audit migrations by deleting history.

[Railway Next.js deployment guide](https://docs.railway.com/guides/nextjs).

## Go-live validation

- Verify HTTPS, unauthorized page/API denial, exact-origin POST checks, health checks, restricted DB permissions and no secrets in client bundles or logs.
- Confirm the authorized ServiceTitan tenant, Richmond business units, QBO realm and card account IDs against actual source screens. Validate cardholder custom fields or individually issued account mappings; test shared-card Unassigned → manual assignment → resync persistence.
- Reconcile a known closed period: compare source counts and signed totals independently; validate pagination over more than one page. Check whether ServiceTitan PO totals include tax/freight and how canceled/closed records are represented. The adapter contract must match your tenant before enabling live use.
- Verify a known charge, grouped payment, split PO purchase, credit, duplicate, late/backdated PO, missing PO and partial payment. Confirm reference conflicts never auto-match. Review proposed matches before approving any policy changes.
- Compare each individual's CSV to their actual card statement, including refunds and shared-PO cases. Ensure proposed links are not mistaken for approved links. Reports describe spend and reconciliation, not employee liability.
- Test missing/expired credentials, rate limits, malformed responses, token refresh/rotation, interrupted sync, concurrent stale updates and restart recovery. A failed sync must leave the previous workspace and audit intact.
- Confirm manual decisions survive an unchanged resync, invalidate on material source/ownership changes, and can be replaced only with another reasoned review. Confirm proposed rules have no effect until approved.
- Run a backup/restore exercise, verify the audit hash chain with `verifyAudit`, and assign an operator for unresolved exceptions. Keep the scope below MVP caps or extend storage and matching job execution before increasing volume.

## Source layout

- `app/page.tsx`, `app/globals.css`: reconciliation, individual filter, details, rules, integrations and audit UI.
- `app/api`: authenticated state/actions/report routes and public health check.
- `lib/engine.ts`, `domain.ts`, `report.ts`: deterministic matching, validated types and safe exports.
- `lib/integrations.ts`: read-only adapters, source mapping and encrypted token rotation.
- `lib/store.ts`, `actions.ts`: transaction boundary, revisions, reservations and audit.
- `db`, `scripts`: schema, migration and guarded test seeding.
- `tests`: matching and integration tests.
