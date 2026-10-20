"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { insertStarterRecipes } from "@/lib/hyetas/insertStarterRecipes";
import { parseIngredientsMd } from "@/lib/hyetas/ingredientLines";

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "side"] as const;
const CONTAINS_TAGS = ["peanut", "avocado", "oats", "banana_cooked"] as const;

async function getHouseholdId(): Promise<string | null> {
  const { getCurrentMember } = await import("@/lib/hyetas/whoami");
  const me = await getCurrentMember();
  // No signed-in member → no household. (Never guess: with multiple
  // families on one DB, "first household" would be someone else's.)
  return me?.household_id ?? null;
}

function readForm(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const cuisine = String(formData.get("cuisine") ?? "").trim() || null;

  const mealTypeValues = formData.getAll("meal_types").map(String);
  const meal_types = MEAL_TYPES.filter((t) => mealTypeValues.includes(t));

  const containsValues = formData.getAll("contains").map(String);
  const contains = CONTAINS_TAGS.filter((t) => containsValues.includes(t));
  const is_peanut_free = !contains.includes("peanut");
  const is_kid_favourite = formData.get("is_kid_favourite") === "on";

  const servingsRaw = String(formData.get("servings") ?? "").trim();
  const servings = servingsRaw ? parseInt(servingsRaw, 10) : 4;

  const prepRaw = String(formData.get("prep_time_min") ?? "").trim();
  const prep_time_min = prepRaw ? parseInt(prepRaw, 10) : null;

  const ingredients_md =
    String(formData.get("ingredients_md") ?? "").trim() || null;
  const instructions_md =
    String(formData.get("instructions_md") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  return {
    name,
    cuisine,
    meal_types,
    servings,
    prep_time_min,
    is_peanut_free,
    is_kid_favourite,
    contains,
    ingredients_md,
    instructions_md,
    notes,
  };
}


/**
 * Rebuild a recipe's grocery-list ingredient rows from its ingredient text.
 * Keeps the aisle / pantry-staple / notes already set on an ingredient
 * with the same name, so editing a recipe doesn't lose them.
 */
async function syncRecipeIngredients(
  supabase: Awaited<ReturnType<typeof createClient>>,
  recipeId: string,
  ingredientsMd: string | null,
): Promise<string | null> {
  const parsed = parseIngredientsMd(ingredientsMd);

  const { data: old } = await supabase
    .from("recipe_ingredients")
    .select("name, aisle, is_pantry_staple, notes")
    .eq("recipe_id", recipeId);
  const keep = new Map<string, { aisle: string | null; is_pantry_staple: boolean; notes: string | null }>();
  for (const o of (old as { name: string; aisle: string | null; is_pantry_staple: boolean; notes: string | null }[] | null) ?? []) {
    keep.set(o.name.toLowerCase(), o);
  }

  const { error: delError } = await supabase
    .from("recipe_ingredients")
    .delete()
    .eq("recipe_id", recipeId);
  if (delError) return delError.message;
  if (!parsed.length) return null;

  const { error } = await supabase.from("recipe_ingredients").insert(
    parsed.map((p) => {
      const prev = keep.get(p.name.toLowerCase());
      return {
        recipe_id: recipeId,
        name: p.name,
        quantity: p.quantity,
        qty_value: p.qty_value,
        qty_unit: p.qty_unit,
        is_optional: p.is_optional,
        section: p.section,
        aisle: prev?.aisle ?? "Other",
        is_pantry_staple: prev?.is_pantry_staple ?? false,
        notes: p.notes ?? prev?.notes ?? null,
      };
    }),
  );
  return error?.message ?? null;
}

export async function addRecipe(formData: FormData) {
  const data = readForm(formData);
  if (!data.name) redirect("/recipes/new?error=Name+is+required");
  if (data.meal_types.length === 0) {
    redirect(
      `/recipes/new?error=${encodeURIComponent("Pick at least one meal type")}`,
    );
  }

  const supabase = await createClient();
  const householdId = await getHouseholdId();
  if (!householdId) redirect("/recipes?error=Household+not+found");

  const { data: inserted, error } = await supabase
    .from("recipes")
    .insert({
      household_id: householdId,
      ...data,
      is_cooked: true,
      is_active: true,
    })
    .select("id")
    .single();

  if (error || !inserted)
    redirect(`/recipes/new?error=${encodeURIComponent(error?.message ?? "Could not save recipe")}`);

  // Also save each ingredient line for the grocery list.
  const ingError = await syncRecipeIngredients(supabase, inserted.id as string, data.ingredients_md);
  if (ingError)
    redirect(`/recipes/${inserted.id}?error=${encodeURIComponent(ingError)}`);

  revalidatePath("/recipes");
  revalidatePath("/meals");
  redirect("/recipes?added=1");
}

export async function updateRecipe(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/recipes?error=Missing+recipe+id");

  const data = readForm(formData);
  if (!data.name)
    redirect(`/recipes/${id}/edit?error=Name+is+required`);
  if (data.meal_types.length === 0) {
    redirect(
      `/recipes/${id}/edit?error=${encodeURIComponent("Pick at least one meal type")}`,
    );
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("recipes")
    .select("ingredients_md")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("recipes")
    .update(data)
    .eq("id", id);

  if (error)
    redirect(`/recipes/${id}/edit?error=${encodeURIComponent(error.message)}`);

  // Only rebuild the grocery-list ingredients when the ingredient text
  // actually changed, so editing just the name or notes leaves them alone.
  const oldMd = (before as { ingredients_md: string | null } | null)?.ingredients_md ?? null;
  if ((oldMd ?? "").trim() !== (data.ingredients_md ?? "").trim()) {
    const ingError = await syncRecipeIngredients(supabase, id, data.ingredients_md);
    if (ingError)
      redirect(`/recipes/${id}/edit?error=${encodeURIComponent(ingError)}`);
  }

  revalidatePath("/recipes");
  revalidatePath(`/recipes/${id}`);
  revalidatePath("/meals");
  redirect(`/recipes/${id}?saved=1`);
}

export async function removeRecipe(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  await supabase
    .from("recipes")
    .update({ is_active: false })
    .eq("id", id);
  revalidatePath("/recipes");
  revalidatePath("/meals");
  redirect("/recipes?removed=1");
}

/** Quick-add ticked starter-catalog recipes from /recipes/new. */
export async function addStarterRecipes(formData: FormData) {
  const householdId = await getHouseholdId();
  if (!householdId) redirect("/");

  const picked = new Set(formData.getAll("starter_recipes").map(String));
  if (picked.size === 0)
    redirect("/recipes/new?error=Tick+at+least+one+starter+first");

  const err = await insertStarterRecipes(householdId!, picked);
  if (err) redirect(`/recipes/new?error=${encodeURIComponent(err)}`);

  revalidatePath("/recipes");
  revalidatePath("/meals");
  redirect("/recipes?added=1");
}
