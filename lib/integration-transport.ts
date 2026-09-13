type Fetcher = typeof fetch;
export const required = (key: string) => {
  const v = process.env[key];
  if (!v?.trim()) throw Error(`Integration configuration missing: ${key}`);
  return v;
};
export async function getJSON(
  url: string,
  headers: Record<string, string>,
  fetcher: Fetcher = fetch,
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    ![
      "quickbooks.api.intuit.com",
      "sandbox-quickbooks.api.intuit.com",
      "api.servicetitan.io",
      "api-integration.servicetitan.io",
    ].includes(u.hostname)
  )
    throw Error("Integration host is not allowed");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const retry = Number(r.headers.get("retry-after"));
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(10000, retry > 0 ? retry * 1000 : 250 * 2 ** attempt),
        ),
      );
      continue;
    }
    throw Error(`Integration GET failed (${u.hostname}, HTTP ${r.status})`);
  }
  throw Error("Integration retry limit");
}
