import { publicVendor } from "@/lib/pm-vendors";
import { createHash, timingSafeEqual } from "node:crypto";
import { authorize } from "@/lib/auth";
import { qboSession, qboBase } from "@/lib/quickbooks";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const id = z.string().regex(/^[0-9]+$/);
const ref = z.object({ value: id });
const vendor = z
  .object({
    DisplayName: z.string().min(1).max(100),
    CompanyName: z.string().max(100),
    PrimaryEmailAddr: z.object({ Address: z.string().email() }),
    PrimaryPhone: z.object({ FreeFormNumber: z.string().max(30) }).optional(),
    BillAddr: z.object({ Line1: z.string().max(500) }).optional(),
    Notes: z.string().max(2000),
  })
  .strict();
const bill = z
  .object({
    VendorRef: ref,
    DocNumber: z.string().min(1).max(21),
    TxnDate: z.string().date(),
    DueDate: z.string().date(),
    PrivateNote: z.string().max(4000),
    Line: z
      .array(
        z.object({
          Amount: z.number().positive(),
          Description: z.string().max(4000),
          DetailType: z.literal("AccountBasedExpenseLineDetail"),
          AccountBasedExpenseLineDetail: z.object({
            AccountRef: ref,
            CustomerRef: ref.optional(),
            BillableStatus: z.literal("NotBillable").optional(),
          }),
        }),
      )
      .length(1),
  })
  .strict();
const schema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("w9"),
      vendorId: id,
      documentId: z.string().uuid(),
      content: z.string().max(11184812),
      mediaType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
      checkOnly: z.boolean(),
    }),
    z.object({
      action: z.literal("tax"),
      vendorId: id,
      taxId: z.string().regex(/^[0-9]{9}$/),
      vendor1099: z.boolean(),
      requestId: z.string().uuid(),
    }),
    z.object({
      action: z.literal("vendorDirectory"),
      start: z.number().int().min(1).max(100001).default(1),
      name: z.string().max(100).optional(),
    }),
    z.object({ action: z.literal("vendor"), id }),
    z.object({
      action: z.literal("syncVendor"),
      vendorId: id,
      expectedName: z.string().min(1),
      requestId: z.string().uuid(),
      payload: z
        .object({
          DisplayName: z.string().min(1).max(100),
          CompanyName: z.string().max(100).optional(),
          Notes: z.string().max(2000).optional(),
          FamilyName: z.string().max(100).optional(),
          PrimaryEmailAddr: z
            .object({ Address: z.string().email() })
            .optional(),
          PrimaryPhone: z
            .object({ FreeFormNumber: z.string().max(30) })
            .optional(),
          BillAddr: z
            .object({
              Line1: z.string().max(500),
              Line2: z.string().max(500).optional(),
              Line3: z.string().max(500).optional(),
              Line4: z.string().max(500).optional(),
              Line5: z.string().max(500).optional(),
              City: z.string().max(255).optional(),
              CountrySubDivisionCode: z.string().max(255).optional(),
              PostalCode: z.string().max(30).optional(),
              Country: z.string().max(255).optional(),
            })
            .optional(),
          GivenName: z.string().max(100).optional(),
        })
        .strict(),
    }),
    z.object({ action: z.literal("catalog") }),
    z.object({
      action: z.literal("vendors"),
      name: z.string().min(1).max(100),
    }),
    z.object({ action: z.literal("bills"), number: z.string().min(1).max(21) }),
    z.object({ action: z.literal("bill"), id }),
    z.object({
      action: z.literal("createVendor"),
      requestId: z.string().uuid(),
      payload: vendor,
    }),
    z.object({
      action: z.literal("createBill"),
      requestId: z.string().uuid(),
      payload: bill,
    }),
  ])
  .and(z.object({ expectedRealm: id.optional() }));
export async function POST(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    authorize(req);
    const key = process.env.PM_ACCOUNTING_KEY;
    if (
      !key ||
      key.length < 32 ||
      !timingSafeEqual(
        createHash("sha256").update(key).digest(),
        createHash("sha256")
          .update(req.headers.get("x-pm-accounting-key") || "")
          .digest(),
      )
    )
      throw Error();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 403, headers });
  }
  let input: z.infer<typeof schema>;
  try {
    const reader = req.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 12000000) {
          await reader.cancel();
          throw Error();
        }
        chunks.push(value);
      }
    input = schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    return Response.json(
      { error: "Invalid accounting request" },
      { status: 400, headers },
    );
  }
  let writing = false;
  try {
    const session = await qboSession();
    if (input.expectedRealm && input.expectedRealm !== session.realm)
      return Response.json(
        { error: "QuickBooks company does not match the PM connection." },
        { status: 409, headers },
      );
    if (
      (input.action.startsWith("create") ||
        input.action === "w9" ||
        input.action === "tax" ||
        input.action === "syncVendor") &&
      !input.expectedRealm
    )
      return Response.json(
        { error: "Company binding required for writes" },
        { status: 400, headers },
      );
    const call = async (path: string, payload?: unknown) => {
      writing = !!payload;
      const res = await fetch(
        `${qboBase()}/v3/company/${encodeURIComponent(session.realm)}/${path}${path.includes("?") ? "&" : "?"}minorversion=75`,
        {
          method: payload ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: payload ? JSON.stringify(payload) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(25000),
        },
      );
      const result = await res.json();
      if (!res.ok) {
        return {
          fault: true,
          status: res.status,
          message: String(
            result?.Fault?.Error?.[0]?.Detail ||
              result?.Fault?.Error?.[0]?.Message ||
              "QuickBooks rejected the request",
          ).slice(0, 700),
        };
      }
      return result;
    };
    const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = (q: string) => call("query?query=" + encodeURIComponent(q));
    let result: any;
    if (input.action === "vendorDirectory") {
      const answer = await query(
        `SELECT * FROM Vendor WHERE Active = true${input.name ? " AND DisplayName LIKE '%" + quote(input.name) + "%'" : ""} STARTPOSITION ${input.start} MAXRESULTS 100`,
      );
      result = answer.fault
        ? answer
        : {
            vendors: (answer.QueryResponse?.Vendor || []).map(publicVendor),
            nextStart:
              (answer.QueryResponse?.Vendor || []).length === 100
                ? input.start + 100
                : null,
          };
    } else if (input.action === "vendor") {
      const answer = await call("vendor/" + input.id);
      result = answer.fault
        ? answer
        : { Vendor: publicVendor(answer.Vendor || {}) };
    } else if (input.action === "syncVendor") {
      const existing = await call("vendor/" + input.vendorId);
      if (existing.fault) result = existing;
      else if (
        !existing.Vendor?.Id ||
        existing.Vendor.Active === false ||
        existing.Vendor.DisplayName !== input.expectedName
      )
        result = {
          fault: true,
          status: 409,
          message:
            "QuickBooks vendor changed or is inactive. Check QuickBooks again.",
        };
      else {
        const patch = input.payload;
        if (!Object.keys(patch).length)
          result = { Vendor: publicVendor(existing.Vendor), updatedFields: [] };
        else {
          const saved = await call("vendor?requestid=" + input.requestId, {
            Id: input.vendorId,
            SyncToken: existing.Vendor.SyncToken,
            sparse: true,
            ...patch,
          });
          result = saved.fault
            ? saved
            : {
                Vendor: publicVendor(saved.Vendor || {}),
                updatedFields: Object.keys(patch),
              };
        }
      }
    } else if (input.action === "tax") {
      const existing = await call("vendor/" + input.vendorId);
      if (existing.fault) result = existing;
      else if (!existing.Vendor?.Id || existing.Vendor.Active === false)
        result = {
          fault: true,
          status: 409,
          message: "Vendor is unavailable or inactive in QuickBooks.",
        };
      else {
        const saved = await call("vendor?requestid=" + input.requestId, {
          Id: input.vendorId,
          SyncToken: existing.Vendor.SyncToken,
          sparse: true,
          TaxIdentifier: input.taxId,
          Vendor1099: input.vendor1099,
        });
        result = saved.fault ? saved : { Vendor: { Id: saved.Vendor?.Id } };
      }
    } else if (input.action === "w9") {
      const filename =
        "PM-W9-" +
        input.documentId +
        (input.mediaType === "application/pdf"
          ? ".pdf"
          : input.mediaType === "image/png"
            ? ".png"
            : ".jpg");
      const found = await query(
        `SELECT * FROM Attachable WHERE FileName = '${filename}' MAXRESULTS 1000`,
      );
      if (found.fault) result = found;
      else {
        const existing = (found.QueryResponse?.Attachable || []).find(
          (a: any) =>
            a.AttachableRef?.some(
              (r: any) =>
                r.EntityRef?.value === input.vendorId &&
                r.EntityRef?.type === "Vendor",
            ),
        );
        if (existing) result = { Attachable: existing };
        else if (input.checkOnly) result = { missing: true };
        else {
          writing = true;
          const form = new FormData();
          form.append(
            "file_metadata_01",
            new Blob(
              [
                JSON.stringify({
                  FileName: filename,
                  ContentType: input.mediaType,
                  AttachableRef: [
                    { EntityRef: { type: "Vendor", value: input.vendorId } },
                  ],
                }),
              ],
              { type: "application/json" },
            ),
            "metadata.json",
          );
          form.append(
            "file_content_01",
            new Blob([new Uint8Array(Buffer.from(input.content, "base64"))], {
              type: input.mediaType,
            }),
            filename,
          );
          const res = await fetch(
            `${qboBase()}/v3/company/${encodeURIComponent(session.realm)}/upload?minorversion=75`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${session.accessToken}`,
                Accept: "application/json",
              },
              body: form,
              redirect: "error",
              signal: AbortSignal.timeout(45000),
            },
          );
          const data = await res.json();
          const a = data.AttachableResponse?.[0];
          result =
            res.ok && a?.Attachable
              ? { Attachable: a.Attachable }
              : {
                  fault: true,
                  status: res.status >= 400 ? res.status : 400,
                  message:
                    "QuickBooks did not accept the W-9 attachment. Review vendor documents.",
                };
        }
      }
    } else if (input.action === "catalog") {
      const all = async (entity: string) => {
        let rows: any[] = [];
        for (let start = 1; start <= 10001; start += 1000) {
          const x = await query(
            `SELECT * FROM ${entity} WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`,
          );
          if (x.fault) throw Error("catalog");
          const batch = x.QueryResponse?.[entity] || [];
          rows.push(...batch);
          if (batch.length < 1000) return rows;
        }
        throw Error("catalog limit");
      };
      const accounts = (await all("Account"))
        .filter((a) =>
          [
            "Expense",
            "Cost of Goods Sold",
            "Other Expense",
            "Other Current Asset",
            "Fixed Asset",
          ].includes(a.AccountType),
        )
        .map((a) => ({
          id: a.Id,
          name: a.FullyQualifiedName || a.Name,
          type: a.AccountType,
        }));
      const customers = (await all("Customer")).map((a) => ({
        id: a.Id,
        name: a.FullyQualifiedName || a.DisplayName,
      }));
      result = { accounts, customers };
    } else if (input.action === "vendors")
      result = await query(
        `SELECT * FROM Vendor WHERE DisplayName = '${quote(input.name)}' MAXRESULTS 1000`,
      );
    else if (input.action === "bills")
      result = await query(
        `SELECT * FROM Bill WHERE DocNumber = '${quote(input.number)}' MAXRESULTS 1000`,
      );
    else if (input.action === "bill") result = await call("bill/" + input.id);
    else
      result = await call(
        (input.action === "createVendor" ? "vendor" : "bill") +
          "?requestid=" +
          input.requestId,
        input.payload,
      );
    return Response.json(
      {
        realm: session.realm,
        environment: process.env.QBO_ENV || "sandbox",
        result,
      },
      { headers },
    );
  } catch {
    return Response.json(
      {
        error: writing
          ? "QuickBooks result uncertain. Check for the existing record before retrying."
          : "QuickBooks connection unavailable.",
        uncertain: writing,
      },
      { status: 503, headers },
    );
  }
}
