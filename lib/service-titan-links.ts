import type { State } from "./domain";
export function serviceTitanJobUrl(state: State, jobId?: string) {
  if (
    state.mode !== "live" ||
    state.serviceTitan?.environment !== "production" ||
    !jobId ||
    !/^[1-9]\d*$/.test(jobId)
  )
    return undefined;
  return "https://go.servicetitan.com/#/Job/Index/" + jobId;
}

export function serviceTitanPOUrl(state: State, invoiceId?: string) {
  if (
    state.mode !== "live" ||
    state.serviceTitan?.environment !== "production" ||
    !invoiceId ||
    !/^[1-9]\d*$/.test(invoiceId)
  )
    return undefined;
  return "https://go.servicetitan.com/#/EditInvoice/" + invoiceId;
}
