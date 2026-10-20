/**
 * Turn a recipe's free-text ingredient list (recipes.ingredients_md) into
 * the structured rows the grocery list reads (recipe_ingredients).
 *
 * Handles lines like:
 *   "500 g chicken breast"          → 500 g  chicken breast
 *   "- 250g bacon"                  → 250 g  bacon
 *   "2 cloves garlic"               → 2 clove garlic
 *   "1/2 cup parmesan"              → 0.5 cup parmesan
 *   "- 1/2 tsp salt, 1/4 tsp pepper"→ two rows (salt, pepper)
 *   "Optional: 2 tbsp chia seeds"   → optional row
 *   "For the chicken:" / "**Rolls:**" → section heading, not an ingredient
 *   "Bunch fresh parsley"           → no amount, name kept as written
 * Pure helpers — no database access.
 */

import { parseQuantity } from "./community";

export type ParsedIngredient = {
  name: string;
  quantity: string | null;
  qty_value: number | null;
  qty_unit: string | null;
  is_optional: boolean;
  section: string | null;
  notes: string | null;
};

// Words we treat as a unit when they come straight after the number.
// Anything else after the number is part of the ingredient name
// ("2 tomatoes" → quantity "2", name "tomatoes").
const UNITS = new Set([
  "g", "gram", "grams", "kg", "kilo", "kilos",
  "ml", "l", "litre", "litres", "liter", "liters",
  "cup", "cups", "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons",
  "clove", "cloves", "slice", "slices", "rasher", "rashers",
  "bunch", "bunches", "packet", "packets", "pack", "packs",
  "bag", "bags", "tin", "tins", "can", "cans", "jar", "jars",
  "head", "heads", "punnet", "punnets", "loaf", "loaves",
  "sachet", "sachets", "tub", "tubs", "box", "boxes",
  "bottle", "bottles", "leaf", "leaves", "sprig", "sprigs",
  "stick", "sticks", "pinch", "pkt", "pkts", "inch",
]);

// Unit spellings parseQuantity doesn't know about.
const EXTRA_UNITS: Record<string, string> = {
  pkt: "packet", pkts: "packet", tub: "tub", tubs: "tub", box: "box", boxes: "box",
  bottle: "bottle", bottles: "bottle", leaf: "leaf", leaves: "leaf",
  sprig: "sprig", sprigs: "sprig", stick: "sticks", sticks: "sticks", inch: "inch", pinch: "pinch",
};

/**
 * Split "chicken thigh fillets, boneless" → name "chicken thigh fillets",
 * notes "boneless"; "pepper (to taste)" → "pepper", "to taste".
 * Keeps the grocery list grouping "tomatoes, diced" with "tomatoes".
 */
function splitNameNotes(text: string): { name: string; notes: string | null } {
  const notes: string[] = [];
  let name = text.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    if (inner.trim()) notes.push(inner.trim());
    return " ";
  });
  const comma = name.indexOf(",");
  if (comma > 0) {
    const after = name.slice(comma + 1).trim();
    if (after) notes.unshift(after);
    name = name.slice(0, comma);
  }
  name = name.replace(/\s+/g, " ").trim();
  return { name: name || text.trim(), notes: notes.length ? notes.join("; ") : null };
}

function normUnit(word: string): string | null {
  const w = word.toLowerCase();
  if (EXTRA_UNITS[w]) return EXTRA_UNITS[w];
  return parseQuantity(`1 ${w}`).unit;
}

// A number at the start: "2", "1.5", "1/2", "1 1/2", or "½" style fractions.
const FRACTIONS: Record<string, string> = { "½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3" };
const NUMBER = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/;

function parseOne(text: string, isOptional: boolean, section: string | null): ParsedIngredient | null {
  const s = text.trim().replace(/[½¼¾⅓⅔]/g, (f) => FRACTIONS[f]);
  if (!s) return null;

  // "(optional)" anywhere marks the item optional.
  if (/\(optional\b/i.test(s)) isOptional = true;

  const num = s.match(NUMBER);
  if (!num) {
    const { name, notes } = splitNameNotes(s);
    return { name, quantity: null, qty_value: null, qty_unit: null, is_optional: isOptional, section, notes };
  }
  let rest = s.slice(num[0].length);
  let unit: string | null = null;
  let unitWord = "";
  // "250g bacon" (no space) or "250 g bacon"
  const unitMatch = rest.match(/^\s*([a-zA-Z]+)\.?(?=\s|$)/);
  if (unitMatch && UNITS.has(unitMatch[1].toLowerCase())) {
    unitWord = unitMatch[1];
    unit = normUnit(unitWord);
    rest = rest.slice(unitMatch[0].length);
  }
  rest = rest.replace(/^\s*(of\s+)?/i, "").trim();
  let { name, notes } = splitNameNotes(rest || s);

  // "3 garlic cloves" / "10 basil leaves" → garlic, 3 clove
  if (!unit) {
    const words = name.split(" ");
    const last = words[words.length - 1];
    if (words.length > 1 && /^(cloves?|leaves|sprigs?)$/i.test(last)) {
      unitWord = last;
      unit = normUnit(last);
      name = words.slice(0, -1).join(" ");
    }
  }

  const value = parseQuantity(num[0]).value;
  return {
    name,
    quantity: unitWord ? `${num[0]} ${unitWord}` : num[0],
    qty_value: value,
    qty_unit: unit,
    is_optional: isOptional,
    section,
    notes,
  };
}

/** Parse the whole ingredient text into rows. */
export function parseIngredientsMd(md: string | null | undefined): ParsedIngredient[] {
  if (!md) return [];
  const out: ParsedIngredient[] = [];
  let section: string | null = null;

  for (const raw of md.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    // Headings: "## Sauce", "**Rolls:**", "For the chicken:"
    const heading = line.match(/^#+\s*(.+)$/) ?? line.match(/^\*\*(.+?):?\*\*:?$/) ?? line.match(/^([^-*•\d][^:]*):$/);
    if (heading) {
      section = heading[1].replace(/:$/, "").trim();
      continue;
    }

    // Strip bullet markers.
    line = line.replace(/^[-*•]\s*/, "").trim();

    // "Optional: x, y" / "To serve (optional): x" / "Toppings: x, y"
    let optional = false;
    const label = line.match(/^([A-Za-z ()]{2,30}):\s*(.+)$/);
    if (label) {
      if (/optional/i.test(label[1])) optional = true;
      line = label[2];
    }

    // Split "1/2 tsp salt, 1/4 tsp pepper" into separate items — but only
    // when at least two parts start with an amount, so "chicken, diced"
    // or "maple syrup, to serve" stays one item.
    const parts = line.split(/,\s*(?![^(]*\))/);
    const withAmounts = parts.filter((p) => NUMBER.test(p.trim().replace(/[½¼¾⅓⅔]/g, (f) => FRACTIONS[f])));
    for (const part of withAmounts.length >= 2 ? parts : [line]) {
      const parsed = parseOne(part, optional, section);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}
