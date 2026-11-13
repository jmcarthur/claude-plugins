// A status's leading verb ("Waiting", "Testing") gets a color of its own. The word is hashed to one of
// 24 colors, 12 hues 30° apart, each at two lightnesses, drawn in OKLCH so no color stands out brighter
// than another of its lightness. The verbs shown together take distinct colors: one whose color another
// took already moves on to the next free one, in a fixed order, so a verb keeps its color while the
// set of verbs on screen stays the same.

// FNV-1a, then MurmurHash3's finalizer: without the finalizer the low bits follow the word's last
// letters, and verbs that share an ending ("-ing") cluster on a few hues.
const hash = (word: string) => {
  let h = 0x811c9dc5;
  for (const c of word.toLowerCase()) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

// OKLab to linear sRGB (Björn Ottosson's matrices).
const toLinear = (L: number, a: number, b: number) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const encode = (x: number) =>
  Math.round(
    255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055),
  );

// A hex color at OKLCH lightness L and chroma up to C, chroma lowered until the hue fits in sRGB.
export const oklch = (L: number, C: number, hue: number): string => {
  const h = (hue * Math.PI) / 180;
  for (let c = C; ; c -= 0.005) {
    const rgb = toLinear(L, c * Math.cos(h), c * Math.sin(h));
    if (c <= 0 || rgb.every((x) => x >= -1e-6 && x <= 1 + 1e-6))
      return `#${rgb
        .map((x) =>
          encode(Math.min(1, Math.max(0, x)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
  }
};

const HUES = 12;
// Both lightnesses read on dark and light terminals alike.
export const PALETTE: readonly string[] = [0.66, 0.8].flatMap((L) =>
  Array.from({ length: HUES }, (_, i) => oklch(L, 0.15, 15 + i * 30)),
);
// A taken color sends a verb this many slots on: coprime with the palette's size, so every slot is
// tried, and far enough round that the next try is another hue.
const STEP = 7;

const slot = (word: string) => hash(word) % PALETTE.length;

// A verb's color on its own, when no other verbs are shown with it.
export const verbColor = (word: string): string => PALETTE[slot(word)];

// The slots of the verbs in use, keeping each slot a verb held before while it is still in use: a new
// verb takes its hashed slot, or the next free one; a verb no longer in use gives its slot up.
export const claimSlots = (
  prev: Readonly<Record<string, number>> | undefined,
  words: readonly string[],
): Record<string, number> => {
  const verbs = [
    ...new Set(words.filter((w) => w !== "").map((w) => w.toLowerCase())),
  ].sort();
  const next: Record<string, number> = {};
  for (const w of verbs) if (prev?.[w] !== undefined) next[w] = prev[w];
  const taken = new Set(Object.values(next));
  for (const w of verbs) {
    if (next[w] !== undefined) continue;
    let s = slot(w);
    for (let i = 0; i < PALETTE.length && taken.has(s); i++)
      s = (s + STEP) % PALETTE.length;
    next[w] = s;
    taken.add(s);
  }
  return next;
};

// The colors of verbs shown together, distinct while there are no more verbs than colors: by the slots
// a book keeps for them, or else by slots they claim fresh, in alphabetical order, so that the result
// depends only on the set. A verb with no slot takes its own hashed color.
export const verbColors =
  (
    words: readonly string[],
    slots: Readonly<Record<string, number>> = claimSlots(undefined, words),
  ): ((word: string) => string) =>
  (word) => {
    const s = slots[word.toLowerCase()];
    return s === undefined ? verbColor(word) : PALETTE[s];
  };

// A status split at its leading word, which takes the verb's color.
export const statusParts = (text: string): { verb: string; rest: string } => {
  const verb = /^[\p{L}'’-]+/u.exec(text)?.[0] ?? "";
  return { verb, rest: text.slice(verb.length) };
};
