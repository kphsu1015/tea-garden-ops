import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const FORBIDDEN_MESSAGE = "找不到這個分類，或您沒有權限操作（僅管理員可以修改／刪除分類）。";

export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改分類。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  const { id } = await params;
  try {
    const body = await request.json() as { name?: string; active?: boolean; sortOrder?: number };
    const updates: Record<string, unknown> = {};
    let newName: string | null = null;
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "請輸入分類名稱。" }, { status: 400 });
      if (name.length > 50) return NextResponse.json({ error: "分類名稱最多50個字。" }, { status: 400 });
      newName = name;
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (typeof body.sortOrder === "number") {
      if (!Number.isInteger(body.sortOrder)) return NextResponse.json({ error: "排序必須是整數。" }, { status: 400 });
      updates.sort_order = body.sortOrder;
    }
    if (newName === null && Object.keys(updates).length === 0) return NextResponse.json({ error: "沒有可更新的欄位。" }, { status: 400 });

    // 改名：資料庫函式會在同一個交易裡，把這個分類底下的庫存品項與進貨明細一起改成新名稱。
    if (newName !== null) {
      const { error: renameError } = await supabase.rpc("rename_inventory_category", { p_id: id, p_name: newName });
      if (renameError) {
        if (renameError.code === "23505") return NextResponse.json({ error: "已有相同名稱的分類。" }, { status: 409 });
        if (renameError.code === "42501") return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
        if (renameError.code === "P0002") return NextResponse.json({ error: "找不到這個分類。" }, { status: 404 });
        if (renameError.code === "22023") return NextResponse.json({ error: "分類名稱不正確。" }, { status: 400 });
        throw renameError;
      }
    }

    // 只改名時沒有其他欄位要更新（空的更新會出錯），直接讀回目前的資料。
    const columns = "id,name,sort_order,active,created_at";
    const { data, error } = Object.keys(updates).length === 0
      ? await supabase.from("inventory_categories").select(columns).eq("id", id)
      : await supabase.from("inventory_categories").update(updates).eq("id", id).select(columns);
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

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

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
