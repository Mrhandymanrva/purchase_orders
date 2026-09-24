import type { State, Result } from "@/lib/domain";
import {
  serviceTitanJobUrl,
  serviceTitanPOUrl,
} from "@/lib/service-titan-links";
export function JobLinks({
  state,
  result,
  display = "both",
}: {
  state: State;
  result: Result;
  display?: "both" | "number" | "id";
}) {
  const records = [
    ...new Map(
      result.pos
        .map((id) => state.records.find((p) => p.id === id))
        .filter((p) => p?.jobId)
        .map((p) => [p!.jobId, p!]),
    ).values(),
  ];
  if (!records.length) return <>—</>;
  return (
    <>
      {records.map((p, index) => {
        const href = serviceTitanJobUrl(state, p.jobId);
        const label = display === "id" ? p.jobId : p.jobNumber || p.jobId;
        return (
          <span key={p.jobId}>
            {index > 0 ? "; " : ""}
            {href ? (
              <a
                className="st-record-link"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title="Open job in ServiceTitan (new tab)"
              >
                {label}
              </a>
            ) : (
              label
            )}
            {display === "both" && p.jobNumber && (
              <small>
                ID:{" "}
                {href ? (
                  <a
                    className="st-record-link"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open job in ServiceTitan (new tab)"
                  >
                    {p.jobId}
                  </a>
                ) : (
                  p.jobId
                )}
              </small>
            )}
          </span>
        );
      })}
    </>
  );
}

export function POLinks({ state, result }: { state: State; result: Result }) {
  if (!result.pos.length) return <>—</>;
  return (
    <>
      {result.pos.map((id, index) => {
        const p = state.records.find((p) => p.id === id);
        const label = p?.reference || "ID: " + id;
        const href = serviceTitanPOUrl(state, p?.invoiceId);
        return (
          <span key={id}>
            {index > 0 ? "; " : ""}
            {href ? (
              <a
                className="st-record-link"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title="View PO on its ServiceTitan invoice (new tab)"
              >
                {label}
              </a>
            ) : (
              label
            )}
          </span>
        );
      })}
    </>
  );
}
