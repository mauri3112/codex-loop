import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composer-keyboard";

const enter = {
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
};

describe("composer keyboard behavior", () => {
  it("submits on unmodified Enter", () => {
    expect(shouldSubmitComposer(enter)).toBe(true);
  });

  it.each(["shiftKey", "metaKey", "ctrlKey", "altKey"] as const)("keeps a newline shortcut for %s + Enter", (modifier) => {
    expect(shouldSubmitComposer({ ...enter, [modifier]: true })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(shouldSubmitComposer({ ...enter, key: "a" })).toBe(false);
  });
});
