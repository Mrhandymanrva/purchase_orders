export function publicVendor(v: any) {
  return {
    Id: v.Id,
    DisplayName: v.DisplayName,
    CompanyName: v.CompanyName,
    Active: v.Active,
    PrimaryEmailAddr: v.PrimaryEmailAddr,
    PrimaryPhone: v.PrimaryPhone,
    BillAddr: v.BillAddr,
    GivenName: v.GivenName,
    FamilyName: v.FamilyName,
    Notes: v.Notes,
  };
}
