"use client";
import { useState } from "react";
import type { State, SpendCategory } from "@/lib/domain";
import { spendCategories } from "@/lib/spend-categories";
export default function SpendCategorySettings({
  state,
  busy,
  onSave,
}: {
  state: State;
  busy: boolean;
  onSave: (body: object) => Promise<boolean>;
}) {
  const saved = spendCategories(state);
  const [rows, setRows] = useState<SpendCategory[]>(() =>
    saved.map((c) => ({ ...c })),
  );
  const [error, setError] = useState("");
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const change = (id: string, patch: Partial<SpendCategory>) =>
    setRows((all) => all.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  return (
    <section className="panel category-settings">
      <h2>Spend categories</h2>
      <p>
        Categories for individual purchases that do not need a PO. Add or rename
        choices here, then save. Turn off Available to hide a choice from new
        selections; existing purchases keep their category.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const ok = await onSave({
            type: "save-spend-categories",
            categories: rows,
          });
          if (!ok)
            setError(
              "Categories were not saved. Check the error message and correct the list.",
            );
        }}
      >
        <div className="category-list">
          {rows.map((c, i) => (
            <div className="category-edit-row" key={c.id}>
              <label className="field">
                Category name
                <input
                  aria-label={"Category name " + (i + 1)}
                  value={c.name}
                  required
                  maxLength={60}
                  onChange={(e) => change(c.id, { name: e.target.value })}
                />
              </label>
              <label className="category-available">
                <input
                  type="checkbox"
                  checked={c.active}
                  aria-label={"Available: " + (c.name || "new category")}
                  onChange={(e) => change(c.id, { active: e.target.checked })}
                />{" "}
                Available
              </label>
              {!saved.some((s) => s.id === c.id) && (
                <button
                  type="button"
                  onClick={() =>
                    setRows((all) => all.filter((r) => r.id !== c.id))
                  }
                >
                  Remove new category
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="category-buttons">
          <button
            type="button"
            disabled={busy || rows.length >= 100}
            onClick={() =>
              setRows((all) => [
                ...all,
                { id: crypto.randomUUID(), name: "", active: true },
              ])
            }
          >
            Add category
          </button>
          <button className="primary" disabled={busy || !dirty}>
            Save categories
          </button>
          {dirty && <span className="badge warning">Unsaved changes</span>}
        </div>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
