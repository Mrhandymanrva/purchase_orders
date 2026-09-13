import { authorize, checkOrigin } from "@/lib/auth";
import { demoMode, Conflict } from "@/lib/store";
import {
  discoverQBOAccounts,
  saveQBOSelection,
  qboSelectionSchema,
  QuickBooksError,
} from "@/lib/quickbooks";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  let actor: string;
  try {
    actor = authorize(req);
    checkOrigin(req);
  } catch {
    return Response.json({ error: "Unauthorized request" }, { status: 403 });
  }
  if (demoMode())
    return Response.json(
      {
        error:
          "QuickBooks connection setup is available in the deployed workspace.",
      },
      { status: 400 },
    );
  try {
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20000) {
          await reader.cancel();
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        chunks.push(value);
      }
    const parsed = z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("discover"),
          revision: z.number().int().nonnegative(),
        }),
        qboSelectionSchema.extend({ action: z.literal("save") }),
      ])
      .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success)
      return Response.json(
        { error: "Choose a parent, at least one card, and enter a reason." },
        { status: 400 },
      );
    const input = parsed.data;
    const state =
      input.action === "discover"
        ? await discoverQBOAccounts(input.revision, actor)
        : await saveQBOSelection(input, actor);
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof QuickBooksError || e instanceof Conflict
            ? e.message
            : "QuickBooks card accounts could not be loaded or saved. Check the connection and Accounting API access, then retry.",
      },
      {
        status: e instanceof Conflict ? 409 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
