const assert = require("node:assert/strict");
(async () => {
  const base = "http://127.0.0.1:3000";
  const response = await fetch(base + "/api/state");
  assert.equal(response.status, 200);
  let s = await response.json();
  assert.equal(s.mode, "demo", "This smoke script requires a disposable demo");
  const post = (body) =>
    fetch(base + "/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ ...body, revision: s.revision }),
    });
  const existing = s.cardMappings?.find((m) => m.accountId === "demo-81");
  let r = await post({
    type: "save-card-mapping",
    mapping: {
      id: existing?.id,
      accountId: "demo-81",
      cardUser: "Alex Morgan",
      from: "2026-09-01",
      reason: "Demo QA: verified individual subaccount roster",
    },
  });
  assert.equal(r.status, 200);
  s = await r.json();
  assert.ok(
    s.records
      .filter((q) => q.accountId === "demo-81")
      .every(
        (q) =>
          q.cardUser === "Alex Morgan" &&
          q.ownershipSource === "Verified subaccount mapping",
      ),
  );
  assert.equal(s.audit.at(-1).action, "Card subaccount mapping saved");
  r = await post({
    type: "save-card-mapping",
    mapping: {
      accountId: "demo-81",
      cardUser: "Other User",
      from: "2026-09-01",
      reason: "Should reject an overlap",
    },
  });
  assert.equal(r.status, 400);
  r = await post({ type: "sync" });
  assert.equal(r.status, 200);
  s = await r.json();
  assert.equal(
    s.cardMappings.find((m) => m.accountId === "demo-81").cardUser,
    "Alex Morgan",
  );
  const csv = await (
    await fetch(base + "/api/report?individual=Alex%20Morgan")
  ).text();
  assert.ok(csv.includes("demo-81"));
  assert.ok(csv.includes("PO-2041"));
  assert.ok(!csv.includes("demo-82"));
  console.log(
    "Subaccount HTTP checks passed: save, audit, overlapping-period rejection, resync and individual report with PO links.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
