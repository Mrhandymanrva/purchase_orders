import { actionSchema, applyAction } from "@/lib/actions";
import { changeState, Conflict, readState } from "@/lib/store";
import { authorize, checkOrigin } from "@/lib/auth";
import { fetchSnapshot, fetchDirectories } from "@/lib/integrations";
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
    const text = Buffer.concat(chunks).toString("utf8");
    const parsed = actionSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      return Response.json(
        { error: parsed.error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    const action = parsed.data;
    const current = ["sync", "refresh-directory"].includes(action.type)
      ? await readState()
      : undefined;
    if (current && current.revision !== action.revision)
      throw new Conflict("Workspace changed. Refresh the page and retry.");
    const snapshot =
      action.type === "sync" && current?.mode === "live"
        ? await fetchSnapshot()
        : undefined;
    const directory =
      action.type === "refresh-directory" && current?.mode === "live"
        ? await fetchDirectories()
        : snapshot?.directory;
    const state = await changeState(action.revision, (s) =>
      applyAction(
        s,
        action,
        actor,
        snapshot?.records,
        directory,
        snapshot?.coverage,
      ),
    );
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Request failed";
    console.error("Action failed:", message);
    return Response.json(
      {
        error:
          e instanceof Conflict
            ? message
            : message.startsWith("Integration")
              ? "Integration sync failed; no source data was changed. Check server logs."
              : message,
      },
      { status: e instanceof Conflict ? 409 : 400 },
    );
  }
}
