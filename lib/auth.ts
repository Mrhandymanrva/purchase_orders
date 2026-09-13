import { timingSafeEqual, createHash } from "node:crypto";
import { demoMode } from "./store";
export function authorize(req: Request) {
  if (demoMode()) return "demo-operator";
  const user = process.env.APP_USER,
    password = process.env.APP_PASSWORD;
  if (!user || !password || password.length < 20)
    throw Error("Authentication configuration required");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (
    !timingSafeEqual(
      digest(req.headers.get("authorization") || ""),
      digest("Basic " + Buffer.from(user + ":" + password).toString("base64")),
    )
  )
    throw Error("Unauthorized");
  return user;
}
export function checkOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const expected =
    process.env.APP_ORIGIN || (demoMode() ? "http://127.0.0.1:3000" : null);
  if (!expected || origin !== expected) throw Error("Invalid request origin");
}
