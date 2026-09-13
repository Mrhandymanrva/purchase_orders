import { NextRequest, NextResponse } from "next/server";
import {
  consumeQBOState,
  completeQBOConnection,
  qboRedirectUri,
  QBO_COOKIE,
} from "@/lib/quickbooks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  let outcome = "failed";
  try {
    const params = req.nextUrl.searchParams;
    if (
      ["state", "code", "realmId", "error"].some(
        (key) => params.getAll(key).length > 1,
      )
    )
      throw Error("Duplicate OAuth parameters");
    const actor = await consumeQBOState(
      params.get("state") || "",
      req.cookies.get(QBO_COOKIE)?.value || "",
    );
    if (params.has("error")) outcome = "denied";
    else {
      await completeQBOConnection(
        params.get("realmId") || "",
        params.get("code") || "",
        actor,
      );
      outcome = "connected";
    }
  } catch {
    // Never log authorization codes, query strings, tokens or provider bodies.
    console.error(
      "QuickBooks callback could not complete; restart connection from Integrations.",
    );
  }
  let target: URL;
  try {
    target = new URL(qboRedirectUri());
    target.pathname = "/";
  } catch {
    return new Response(
      "QuickBooks connection unavailable. Check APP_ORIGIN.",
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
  target.search = new URLSearchParams({
    tab: "Integrations",
    quickbooks: outcome,
  }).toString();
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(QBO_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
