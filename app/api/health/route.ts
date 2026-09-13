import { demoMode, pool } from "@/lib/store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    if (!demoMode()) {
      if (
        !process.env.APP_USER ||
        !process.env.APP_PASSWORD ||
        process.env.APP_PASSWORD.length < 20 ||
        !process.env.APP_ORIGIN
      )
        throw Error();
      await pool().query("SELECT id FROM app_state WHERE id=1");
    }
    return Response.json({ status: "ok", mode: demoMode() ? "demo" : "live" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
