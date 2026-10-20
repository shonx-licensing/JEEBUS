/**
 * Shared core for adding starter-catalog recipes to a household — used by
 * the creator wizard AND the "quick-add" section on /recipes/new.
 * Skips any recipe whose name already exists in the household, so it can
 * never duplicate. Returns an error message, or null on success.
 */

import { createClient } from "@/lib/supabase/server";
import { STARTER_RECIPES } from "@/lib/hyetas/starterPacks";
import { starterStyle } from "@/lib/hyetas/starterStyleTags";
import { parseQuantity } from "@/lib/hyetas/community";

export async function insertStarterRecipes(
  householdId: string,
  picked: Set<string>,
): Promise<string | null> {
  if (picked.size === 0) return null;

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("recipes")
    .select("name")
    .eq("household_id", householdId);
  const have = new Set(
    ((existing as { name: string }[] | null) ?? []).map((r) =>
      r.name.toLowerCase(),
    ),
  );

  for (const r of STARTER_RECIPES) {
    if (!picked.has(r.key) || have.has(r.name.toLowerCase())) continue;
    const { data: inserted, error } = await supabase
      .from("recipes")
      .insert({
        household_id: householdId,
        name: r.name,
        cuisine: r.cuisine,
        meal_types: ["dinner"],
        servings: 4,
        prep_time_min: r.prep_time_min,
        instructions_md: r.instructions_md,
        is_kid_favourite: r.is_kid_favourite,
        is_active: true,
        style_tags: starterStyle(r.name).tags,
        est_cost_aud: starterStyle(r.name).cost,
      })
      .select("id")
      .single();
    if (error || !inserted)
      return error?.message ?? "Could not save recipes";
    const { error: ingError } = await supabase
      .from("recipe_ingredients")
      .insert(
        r.ingredients.map((i) => {
          // Store the number + unit too ("500 g" → 500, "g") so the
          // grocery list can add amounts up, not just show the text.
          const q = parseQuantity(i.quantity);
          return {
          recipe_id: inserted!.id,
          name: i.name,
          quantity: i.quantity,
          qty_value: q.value,
          qty_unit: q.unit,
          aisle: i.aisle,
          is_pantry_staple: i.is_pantry_staple ?? false,
          };
        }),
      );
    if (ingError) return ingError.message;
  }
  return null;
}
