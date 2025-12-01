import journal from "./mailing-list-do/migrations/meta/_journal.json";
import m0000 from "./mailing-list-do/migrations/0000_fair_hardball.sql?raw";

export default {
  journal,
  migrations: {
    m0000,
  },
} satisfies {
  journal: {
    entries: {
      idx: number;
      when: number;
      tag: string;
      breakpoints: boolean;
    }[];
  };
  migrations: Record<string, string>;
};
