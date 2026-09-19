import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const FORBIDDEN_MESSAGE = "找不到這個分類，或您沒有權限操作（僅管理員可以修改／刪除分類）。";

export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改分類。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  const { id } = await params;
  try {
    const body = await request.json() as { name?: string; active?: boolean; sortOrder?: number };
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "請輸入分類名稱。" }, { status: 400 });
      if (name.length > 50) return NextResponse.json({ error: "分類名稱最多50個字。" }, { status: 400 });
      updates.name = name;
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (typeof body.sortOrder === "number") updates.sort_order = body.sortOrder;
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: "沒有可更新的欄位。" }, { status: 400 });

    const { data, error } = await supabase
      .from("inventory_categories")
      .update(updates)
      .eq("id", id)
      .select("id,name,sort_order,active,created_at");
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的分類。" }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
      throw error;
    }
    if (!data || data.length === 0) return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });

    const category = data[0];
    return NextResponse.json({
      category: { id: category.id, name: category.name, sortOrder: category.sort_order, active: category.active, createdAt: category.created_at },
    });
  } catch (error) {
    console.error("Update category failed", error);
    return NextResponse.json({ error: "更新分類失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法刪除分類。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  const { id } = await params;
  try {
    const { data: category, error: fetchError } = await supabase
      .from("inventory_categories")
      .select("name")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!category) return NextResponse.json({ error: "找不到這個分類。" }, { status: 404 });

    const [itemResult, lineResult] = await Promise.all([
      supabase.from("inventory_items").select("id", { count: "exact", head: true }).eq("category", category.name),
      supabase.from("receipt_lines").select("id", { count: "exact", head: true }).eq("category", category.name),
    ]);
    if (itemResult.error) throw itemResult.error;
    if (lineResult.error) throw lineResult.error;
    if ((itemResult.count ?? 0) > 0 || (lineResult.count ?? 0) > 0) {
      return NextResponse.json({ error: "此分類仍有庫存品項或進貨紀錄使用中，請先將品項移動到其他分類，或改為停用此分類。" }, { status: 409 });
    }

    const { data: deleted, error } = await supabase.from("inventory_categories").delete().eq("id", id).select("id");
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
      throw error;
    }
    if (!deleted || deleted.length === 0) return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete category failed", error);
    return NextResponse.json({ error: "刪除分類失敗，請稍後再試。" }, { status: 500 });
  }
}
