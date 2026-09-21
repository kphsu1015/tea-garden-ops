import { NextResponse } from "next/server";
import { demoCategoryList, listCategories } from "@/lib/categories";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ categories: demoCategoryList(), demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const categories = await listCategories(supabase);
    return NextResponse.json({ categories, demo: false });
  } catch (error) {
    console.error("List categories failed", error);
    return NextResponse.json({ error: "讀取分類失敗，請稍後再試。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增分類。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as { name?: string };
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "請輸入分類名稱。" }, { status: 400 });
    if (name.length > 50) return NextResponse.json({ error: "分類名稱最多50個字。" }, { status: 400 });

    const { data: lastCategory, error: lastError } = await supabase
      .from("inventory_categories")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;
    const nextOrder = (lastCategory?.sort_order ?? 0) + 1;

    const { data, error } = await supabase
      .from("inventory_categories")
      .insert({ name, sort_order: nextOrder, active: true })
      .select("id,name,sort_order,active,created_at")
      .single();
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "已有相同名稱的分類。" }, { status: 409 });
      if (error.code === "42501") return NextResponse.json({ error: "只有管理員能新增分類。" }, { status: 403 });
      throw error;
    }

    return NextResponse.json({
      category: {
        id: data.id,
        name: data.name,
        sortOrder: data.sort_order,
        active: data.active,
        itemCount: 0,
        receiptLineCount: 0,
        createdAt: data.created_at,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Create category failed", error);
    return NextResponse.json({ error: "新增分類失敗，請稍後再試。" }, { status: 500 });
  }
}
