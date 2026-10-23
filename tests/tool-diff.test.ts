import { expect, test } from "bun:test";
import { editDiff } from "../src/tool-diff.ts";

test("portable diff helper computes retained replacement regions without reading files", () => {
  const input = { edits: [{ oldText: "before\nold\nafter", newText: "before\nnew\nafter" }, { oldText: "", newText: "inserted" }] };
  const result = editDiff(input, {})!;
  expect(result.before).toEqual(["old"]); expect(result.after).toEqual(["new", "inserted"]);
  expect(result.regions).toBe(2); expect(result.relative).toBe(true); expect(result.incomplete).toBe(false);
  expect(result.text).toContain("Replacement 1"); expect(result.text).toContain("Replacement 2");
  expect(editDiff({}, {})).toBeUndefined();
  expect(editDiff({ edits: [input.edits[0], null] }, {})!.incomplete).toBe(true);
});
test("supplied patches take precedence and numbered display lines are stripped only when declared", () => {
  const numbered = { diff: " 40 context\n-41 actual old\n+41 actual new", firstChangedLine: 41 };
  expect(editDiff({}, numbered)).toMatchObject({ before: ["actual old"], after: ["actual new"], relative: false });
  const patch = "--- a/source.ts\n+++ b/source.ts\n@@ -10 +10 @@\n-old\n+new";
  expect(editDiff({}, { ...numbered, patch })).toMatchObject({ before: ["old"], after: ["new"] });
  expect(editDiff({ oldText: "-- old", newText: "++ new" }, {})).toMatchObject({ before: ["-- old"], after: ["++ new"] });
});
test("large and excessive replacements degrade explicitly without losing the raw source", () => {
  const large = editDiff({ oldText: Array.from({ length: 300 }, (_, i) => `a${i}`).join("\n"), newText: Array.from({ length: 300 }, (_, i) => `b${i}`).join("\n") }, {})!;
  expect(large.text).toContain("simplified diff"); expect(large.before).toHaveLength(300); expect(large.after).toHaveLength(300);
  const many = editDiff({ edits: Array.from({ length: 65 }, () => ({ oldText: "old", newText: "new" })) }, {})!;
  expect(many.incomplete).toBe(true); expect(many.text).toContain("Additional regions omitted");
});
