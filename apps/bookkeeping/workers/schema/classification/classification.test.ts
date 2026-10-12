import { describe, expect, test } from "vitest";

import { bookkeepingScenario } from "../books.test-support";

describe("classification", () => {
  test("accounts map onto one acyclic node per scheme", () =>
    bookkeepingScenario((books) => {
      books.script(
        `INSERT INTO classification_scheme VALUES ('rgs', 'RGS', 'Referentie Grootboekschema'),
           ('own', 'OWN', 'Management');
         INSERT INTO classification_node VALUES
           ('rgs-w', 'rgs', NULL, 'W', 'Winst- en verliesrekening'),
           ('rgs-wo', 'rgs', 'rgs-w', 'WOmz', 'Netto-omzet'),
           ('own-rev', 'own', NULL, 'REV', 'Revenue')`,
      );
      books.rejects(
        () => books.sql("INSERT INTO classification_node VALUES ('x', 'own', 'rgs-w', 'X', 'x')"),
        "FOREIGN KEY",
      );
      books.rejects(
        () => books.sql("UPDATE classification_node SET parent_id = 'rgs-wo' WHERE id = 'rgs-w'"),
        "Classification hierarchies must not contain cycles",
      );
      books.sql(
        `INSERT INTO classification_account VALUES ('revenue', 'rgs', 'rgs-wo'),
           ('revenue', 'own', 'own-rev')`,
      );
      books.rejects(
        () => books.sql("INSERT INTO classification_account VALUES ('revenue', 'rgs', 'rgs-w')"),
        "UNIQUE",
      );

      expect(
        books.sql("SELECT scheme_id, node_id FROM classification_account ORDER BY scheme_id"),
      ).toEqual([
        { scheme_id: "own", node_id: "own-rev" },
        { scheme_id: "rgs", node_id: "rgs-wo" },
      ]);
    }));
});
