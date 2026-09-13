import { NextResponse, type NextRequest } from "next/server";
export async function middleware(req: NextRequest) {
  if (
    ["/api/health", "/eula", "/privacy-policy"].includes(req.nextUrl.pathname)
  )
    return NextResponse.next();
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production")
    return NextResponse.next();
  const user = process.env.APP_USER,
    password = process.env.APP_PASSWORD;
  if (!user || !password || password.length < 20)
    return new NextResponse("Authentication configuration required", {
      status: 503,
    });
  const expected = "Basic " + btoa(user + ":" + password),
    given = req.headers.get("authorization") || "";
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(expected), hash(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0)
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate":
          'Basic realm="Richmond reconciliation", charset="UTF-8"',
        "Cache-Control": "no-store",
      },
    });
  return NextResponse.next();
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.svg).*)"],
};
