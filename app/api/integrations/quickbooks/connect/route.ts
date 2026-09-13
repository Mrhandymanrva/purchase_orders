import { NextResponse } from "next/server";
import { authorize, checkOrigin } from "@/lib/auth";
import { demoMode } from "@/lib/store";
import {
  startQBOAuthorization,
  QBO_COOKIE,
  QuickBooksError,
} from "@/lib/quickbooks";
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
      { error: "Connect QuickBooks is available in the deployed workspace." },
      { status: 400 },
    );
  try {
    const attempt = await startQBOAuthorization(actor);
    const response = NextResponse.json(
      { url: attempt.url },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
    response.cookies.set(QBO_COOKIE, attempt.browser, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof QuickBooksError
            ? e.message
            : "QuickBooks connection could not start. Check the client ID, client secret, HTTPS app origin and token encryption key in Railway.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
