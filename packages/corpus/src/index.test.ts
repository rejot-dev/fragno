import { describe, it, expect } from "vitest";
import { getSubjects, getSubject, getAllSubjects } from "./index.js";

describe("corpus API", () => {
  describe("getSubjects", () => {
    it("should return array of subject info", () => {
      const subjects = getSubjects();

      expect(subjects).toBeInstanceOf(Array);
      expect(subjects.length).toBeGreaterThan(0);

      // Check structure of first subject
      const first = subjects[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("title");
      expect(typeof first.id).toBe("string");
      expect(typeof first.title).toBe("string");
    });

    it("should include expected subjects", () => {
      const subjects = getSubjects();
      const ids = subjects.map((s) => s.id);

      expect(ids).toContain("defining-routes");
      expect(ids).toContain("database-querying");
      expect(ids).toContain("database-adapters");
      expect(ids).toContain("kysely-adapter");
      expect(ids).toContain("drizzle-adapter");
    });
  });

  describe("getSubject", () => {
    it("should return single subject when given one id", () => {
      const [subject] = getSubject("defining-routes");

      expect(subject).toBeDefined();
      expect(subject.id).toBe("defining-routes");
      expect(subject.title).toBeTruthy();
      expect(subject.description).toBeTruthy();
      expect(subject.imports).toBeTruthy();
      expect(subject.examples).toBeInstanceOf(Array);
      expect(subject.examples.length).toBeGreaterThan(0);
    });

    it("should return multiple subjects when given multiple ids", () => {
      const subjects = getSubject("database-adapters", "kysely-adapter");

      expect(subjects).toHaveLength(2);
      expect(subjects[0].id).toBe("database-adapters");
      expect(subjects[1].id).toBe("kysely-adapter");
    });

    it("should include examples with code and explanation", () => {
      const [subject] = getSubject("defining-routes");

      const example = subject.examples[0];
      expect(example).toHaveProperty("code");
      expect(example).toHaveProperty("explanation");
      expect(typeof example.code).toBe("string");
      expect(typeof example.explanation).toBe("string");
    });

    it("should have prelude and testInit arrays", () => {
      const [subject] = getSubject("defining-routes");

      expect(subject).toHaveProperty("prelude");
      expect(subject).toHaveProperty("testInit");
      expect(Array.isArray(subject.prelude)).toBe(true);
      expect(Array.isArray(subject.testInit)).toBe(true);
    });
  });

  describe("getAllSubjects", () => {
    it("should return all available subjects", () => {
      const allSubjects = getAllSubjects();
      const subjectsList = getSubjects();

      expect(allSubjects).toHaveLength(subjectsList.length);
    });

    it("should return complete subject data", () => {
      const allSubjects = getAllSubjects();

      for (const subject of allSubjects) {
        expect(subject.id).toBeTruthy();
        expect(subject.title).toBeTruthy();
        expect(subject.imports).toBeDefined(); // Can be empty string
        expect(subject.examples).toBeInstanceOf(Array);
      }
    });
  });

  describe("subject content validation", () => {
    it("defining-routes should have multiple examples", () => {
      const [subject] = getSubject("defining-routes");

      expect(subject.examples.length).toBeGreaterThan(3);
      expect(subject.imports).toContain("defineRoute");
    });

    it("database-querying should have database content", () => {
      const [subject] = getSubject("database-querying");

      expect(subject.title).toBe("Database Querying");
      expect(subject.imports).toContain("withDatabase");
      expect(subject.examples.length).toBeGreaterThan(0);
    });

    it("database-adapters should have adapter overview", () => {
      const [subject] = getSubject("database-adapters");

      expect(subject.description).toContain("adapter");
      expect(subject.imports).toContain("DatabaseAdapter");
    });
  });
});
