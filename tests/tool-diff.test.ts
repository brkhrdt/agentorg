import { expect, test } from "bun:test";
import { editDiff } from "../src/tool-diff.ts";
import { renderTool, RendererRegistry } from "../src/rendering.ts";
import type { ServerEvent } from "../src/types.ts";

const event = (rawInput: unknown, data: Record<string, unknown> = {}, type = "tool.call"): ServerEvent => ({
  kind: "event", seq: 1, time: "now", type, data: { title: "edit", rawInput, ...data },
});

test("edit call full view contains changed regions with context, not repeated argument JSON", () => {
  const oldText = Array.from({ length: 40 }, (_, index) => `unchanged_${index}`).join("\n");
  const newText = oldText.replace("unchanged_20", "changed_20");
  const e = event({ path: "source.ts", edits: [{ oldText, newText }] });
  const original = JSON.stringify(e);
  const rendered = renderTool(e);
  expect(rendered.summary).toBe("Δ source.ts · +1 / -1");
  expect(rendered.full).toContain("Proposed changes");
  expect(rendered.full).toContain("replacement-relative line numbers");
  expect(rendered.full).toContain("@@ -18,7 +18,7 @@");
  expect(rendered.full).toContain("-unchanged_20\n+changed_20");
  expect(rendered.full).toContain(" unchanged_19");
  expect(rendered.full).not.toContain("unchanged_0\n");
  expect(rendered.full).not.toContain("unchanged_39");
  expect(rendered.full).not.toContain('"oldText"');
  expect(rendered.extendedDiff).toEqual({ prefix: "Δ source.ts", before: "unchanged_20", after: "changed_20" });
  expect(rendered.extended.split("\n")).toHaveLength(2);
  expect(JSON.stringify(e)).toBe(original);
});

test("edit results prefer actual diff over proposed arguments and strip Pi display line numbers from the preview", () => {
  const rawInput = { path: "source.ts", oldText: "proposal old", newText: "proposal new" };
  const actual = { diff: " 40 context\n-41 actual old\n+41 actual new", firstChangedLine: 41 };
  const result = renderTool(event(rawInput, { status: "completed", rawOutput: { content: [{ type: "text", text: "Successfully replaced text" }], details: actual } }, "tool.result"));
  expect(result.full).toContain("Diff:");
  expect(result.full).toContain(actual.diff);
  expect(result.full).not.toContain("proposal old");
  expect(result.full).not.toContain("Successfully replaced");
  expect(result.extendedDiff).toMatchObject({ before: "actual old", after: "actual new" });
  const patch = "--- a/source.ts\n+++ b/source.ts\n@@ -10 +10 @@\n-old\n+new";
  const withPatch = editDiff({}, { ...actual, patch })!;
  expect(withPatch.before).toEqual(["old"]); expect(withPatch.after).toEqual(["new"]);
});

test("multiple regions, insertions, deletions, empty and unchanged edits remain distinct", () => {
  const input = { path: "a.ts", edits: [{ oldText: "before\nold\nafter", newText: "before\nnew\nafter" }, { oldText: "", newText: "inserted" }] };
  const rendered = renderTool(event(input));
  expect(rendered.summary).toContain("+2 / -1 · 2 regions");
  expect(rendered.full).toContain("Replacement 1"); expect(rendered.full).toContain("Replacement 2");
  expect(rendered.extendedDiff).toMatchObject({ prefix: "Δ a.ts (2 regions)", before: "old", after: "new ↵ inserted" });
  for (const [oldText, newText, before, after] of [["", "new", "∅", "new"], ["old", "", "old", "∅"], ["a\n\nb", "a\nb", "(blank)", "∅"]]) {
    expect(renderTool(event({ path: "a", oldText, newText })).extendedDiff).toMatchObject({ before, after });
  }
  expect(renderTool(event({ path: "a", oldText: "same", newText: "same" })).full).toContain("no text changes");
  const signs = editDiff({ oldText: "-- old", newText: "++ new" }, {})!;
  expect(signs.before).toEqual(["-- old"]); expect(signs.after).toEqual(["++ new"]);
  expect(editDiff({ oldText: "old\n", newText: "new \n" }, {})!.text).toContain("+new ");
});

test("failed edits show the error rather than a misleading green replacement preview", () => {
  const input = { path: "source.ts", edits: [{ oldText: "old", newText: "new" }] };
  const rendered = renderTool(event(input, { status: "failed", rawOutput: { content: [{ type: "text", text: "Could not find old text" }] } }, "tool.result"));
  expect(rendered.summary).toContain("Could not find old text");
  expect(rendered.extendedDiff).toBeUndefined();
  expect(rendered.extended).toContain("Could not find old text");
  expect(rendered.full).toContain("tool failed; may be incomplete");
  expect(rendered.full).not.toContain("Diff:");
});

test("malformed, huge and incomplete edit data is bounded and retains a raw fallback", () => {
  expect(editDiff({}, {})).toBeUndefined();
  const input = { edits: [{ oldText: "old", newText: "new" }, null] };
  expect(editDiff(input, {})!.incomplete).toBe(true);
  expect(renderTool(event(input)).full).toContain('"edits"');
  const large = editDiff({ oldText: Array.from({ length: 300 }, (_, index) => `a${index}`).join("\n"), newText: Array.from({ length: 300 }, (_, index) => `b${index}`).join("\n") }, {})!;
  expect(large.text).toContain("simplified diff"); expect(large.before).toHaveLength(300); expect(large.after).toHaveLength(300);
  const many = renderTool(event({ edits: Array.from({ length: 65 }, () => ({ oldText: "old", newText: "new" })) }));
  expect(many.summary).toContain("TRUNCATED"); expect(many.full).toContain("Additional regions omitted");
  const registry = new RendererRegistry();
  const escaped = registry.render(event({ path: "a.ts", edits: [{ oldText: "```\nold", newText: "```\nnew" }] }), undefined, "core.tools")!;
  expect(escaped.extendedDiff).toMatchObject({ before: "old", after: "new" });
  expect(escaped.summary.split("\n")).toHaveLength(1);
  expect(escaped.extended.split("\n")).toHaveLength(2);
});
