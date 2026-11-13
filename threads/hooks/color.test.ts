import { test, expect } from "claude-code/testing";
import {
  claimSlots,
  oklch,
  PALETTE,
  statusParts,
  verbColor,
  verbColors,
} from "./color";

test("a verb's color is a hex color, the same for the same word in any case", () => {
  expect(verbColor("Waiting")).toMatch(/^#[0-9a-f]{6}$/);
  expect(verbColor("Waiting")).toBe(verbColor("waiting"));
  const colors = new Set(
    [
      "Waiting",
      "Testing",
      "Building",
      "Checking",
      "Investigating",
      "Updating",
    ].map(verbColor),
  );
  expect(colors.size).toBeGreaterThan(3);
});

test("verbs that share an ending spread over the palette, and verbs shown together never share a color", () => {
  const verbs = [
    "Waiting",
    "Testing",
    "Building",
    "Investigating",
    "Reviewing",
    "Drafting",
    "Releasing",
    "Fixing",
    "Planning",
    "Checking",
    "Updating",
    "Running",
  ];
  expect(new Set(verbs.map(verbColor)).size).toBeGreaterThanOrEqual(8);
  const colorOf = verbColors(verbs);
  expect(new Set(verbs.map(colorOf)).size).toBe(verbs.length);
  expect(new Set(PALETTE).size).toBe(PALETTE.length);
  // The same set gives the same colors, whatever its order or case.
  const again = verbColors([...verbs].reverse().map((v) => v.toUpperCase()));
  expect(verbs.map(again)).toEqual(verbs.map(colorOf));
});

test("oklch gives a known color and stays in gamut", () => {
  expect(oklch(1, 0, 0)).toBe("#ffffff");
  expect(oklch(0, 0, 0)).toBe("#000000");
  for (let h = 0; h < 360; h += 15)
    expect(oklch(0.7, 0.3, h)).toMatch(/^#[0-9a-f]{6}$/);
});

test("a status splits at its leading word", () => {
  expect(statusParts("Waiting on q3.")).toEqual({
    verb: "Waiting",
    rest: " on q3.",
  });
  expect(statusParts("3 tests left")).toEqual({
    verb: "",
    rest: "3 tests left",
  });
});

test("a verb keeps its slot while it is in use, and gives it up once it is not", () => {
  const all = ["Waiting", "Testing", "Building", "Reviewing", "Releasing"];
  const a = claimSlots(undefined, all);
  expect(new Set(Object.values(a)).size).toBe(all.length);
  // A verb sorting first arrives: no verb in use moves.
  const b = claimSlots(a, ["Adding", ...all]);
  for (const w of all) expect(b[w.toLowerCase()]).toBe(a[w.toLowerCase()]);
  expect(Object.values(b).filter((s) => s === b.adding)).toHaveLength(1);
  // One goes out of use: the rest stay, and it is dropped.
  const c = claimSlots(b, ["Adding", "Waiting", "Testing"]);
  expect(c).toEqual({
    adding: b.adding,
    waiting: b.waiting,
    testing: b.testing,
  });
});
