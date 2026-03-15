import { describe, expect, test } from "vitest";

import { DELETED_SELECTED_FILE_MESSAGE, getVisibleSelectedFileError } from "./files-view-state";

describe("getVisibleSelectedFileError", () => {
  test("hides the deleted selection warning after deleting that selected file", () => {
    expect(
      getVisibleSelectedFileError({
        selectedFileError: DELETED_SELECTED_FILE_MESSAGE,
        actionOk: true,
        actionIntent: "delete-file",
        actionFileKey: "files/example.csv",
        actionProvider: "r2-binding",
        selectedFileKey: "files/example.csv",
        selectedFileProvider: "r2-binding",
      }),
    ).toBeNull();
  });

  test("keeps the deleted selection warning for unrelated actions", () => {
    expect(
      getVisibleSelectedFileError({
        selectedFileError: DELETED_SELECTED_FILE_MESSAGE,
        actionOk: true,
        actionIntent: "download-url",
        actionFileKey: "files/example.csv",
        actionProvider: "r2-binding",
        selectedFileKey: "files/example.csv",
        selectedFileProvider: "r2-binding",
      }),
    ).toBe(DELETED_SELECTED_FILE_MESSAGE);
  });

  test("keeps the deleted selection warning for a different selected file", () => {
    expect(
      getVisibleSelectedFileError({
        selectedFileError: DELETED_SELECTED_FILE_MESSAGE,
        actionOk: true,
        actionIntent: "delete-file",
        actionFileKey: "files/other.csv",
        actionProvider: "r2-binding",
        selectedFileKey: "files/example.csv",
        selectedFileProvider: "r2-binding",
      }),
    ).toBe(DELETED_SELECTED_FILE_MESSAGE);
  });
});
