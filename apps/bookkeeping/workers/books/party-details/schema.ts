import { column, idColumn, schema } from "@fragno-dev/db/schema";

/**
 * What the books know of a customer or supplier as a company, beyond the ledger's name: its
 * registration number, such as a KvK number, its VAT number, its IBAN in electronic form, and its
 * address. One row per ledger party, named by its ID, whichever roles it has; null fields are not
 * known.
 */
export const partyDetailsSchema = schema("party-details", (s) => {
  return s.addTable("partyDetails", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("partyId", column("string"))
      .addColumn("registrationNumber", column("string").nullable())
      .addColumn("vatNumber", column("string").nullable())
      .addColumn("iban", column("string").nullable())
      .addColumn("address", column("string").nullable())
      .addColumn("updatedAt", column("timestamp"))
      .addColumn("updatedBy", column("string"))
      .createIndex("idx_party_details_party", ["partyId"], { unique: true });
  });
});
