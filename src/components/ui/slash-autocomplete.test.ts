import { describe, expect, it } from "vitest";
import type { TaskCapability } from "../../domain/task-capabilities";
import { applyTaskCapability, filterTaskCapabilities, findSlashQuery } from "./slash-autocomplete";

const items: TaskCapability[] = [
  { id: "skill:pdf", kind: "skill", label: "pdf", description: "Work with PDFs", invocation: "$pdf " },
  { id: "computer-use", kind: "computer-use", label: "Computer use", description: "Control local apps", invocation: "$computer-use " },
  { id: "mcp:github", kind: "mcp", label: "GitHub", description: "12 MCP tools", invocation: "Use the GitHub MCP server to " },
];

describe("slash task autocomplete", () => {
  it("recognizes a slash query at the caret only at a token boundary", () => {
    expect(findSlashQuery("/gi", 3)).toEqual({ start: 0, end: 3, query: "gi" });
    expect(findSlashQuery("Please /pdf", 11)).toEqual({ start: 7, end: 11, query: "pdf" });
    expect(findSlashQuery("https://example.com", 19)).toBeNull();
    expect(findSlashQuery("/pdf then", 9)).toBeNull();
  });

  it("filters across labels, descriptions, and capability kinds", () => {
    expect(filterTaskCapabilities(items, "git").map((item) => item.id)).toEqual(["mcp:github"]);
    expect(filterTaskCapabilities(items, "local").map((item) => item.id)).toEqual(["computer-use"]);
  });

  it("replaces only the active slash token and preserves following text", () => {
    const result = applyTaskCapability("Please /gi carefully", { start: 7, end: 10, query: "gi" }, items[2]);
    expect(result.value).toBe("Please Use the GitHub MCP server to  carefully");
    expect(result.caret).toBe(36);
  });
});
