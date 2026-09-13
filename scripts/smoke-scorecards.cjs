const assert = require("node:assert/strict");
async function main() {
  const base = "http://127.0.0.1:3000";
  const s = await (await fetch(base + "/api/state")).json();
  assert.equal(
    s.mode,
    "demo",
    "Use this check only against the local sample server",
  );
  assert.ok(s.directory.people.length);
  assert.ok(s.directory.accounts.length);
  const get = async (params) => {
    const response = await fetch(
      base + "/api/scorecard?" + new URLSearchParams(params),
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  const month = await get({
    unit: "month",
    year: "2026",
    period: "9",
    person: "technician:demo-3",
  });
  assert.ok(month.includes("Taylor Reed"));
  assert.ok(month.includes("914.99"));
  assert.ok(month.includes("Sample data"));
  assert.ok(!month.includes("Chris Parker"));
  const week = await get({
    unit: "week",
    year: "2026",
    period: "37",
    person: "technician:demo-3",
  });
  assert.ok(week.includes("625"));
  assert.ok(week.includes("2026-09-07"));
  const year = await get({
    unit: "year",
    year: "2025",
    period: "1",
    person: "technician:demo-3",
  });
  assert.ok(!year.includes("914.99"));
  assert.equal(
    (await fetch(base + "/api/scorecard?unit=week&year=2025&period=53")).status,
    400,
  );
  const mappings = await (
    await fetch(base + "/api/card-mappings/export")
  ).text();
  assert.ok(mappings.includes("ST Person ID"));
  console.log(
    "Scorecard HTTP checks passed: month/week/year, technician filtering, coverage export, invalid period rejection and mapping IDs.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
