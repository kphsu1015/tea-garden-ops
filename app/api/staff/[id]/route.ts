import { NextResponse } from "next/server";
import { isAssignableStaffRole, mapStaffRow } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const FORBIDDEN_MESSAGE = "找不到這位員工，或您沒有權限修改（僅管理員可以設定角色、停用及重新啟用員工）。";

export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法修改員工。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  const { id } = await params;
  try {
    const body = await request.json() as { role?: string; active?: boolean; displayName?: string };

    // 防呆：is_active_staff()會檢查自己那筆staff_profiles是否active，一旦自己被停用，
    // 連讀取／修改staff_profiles（包含自己）的權限都會一起消失，變成沒有人能從畫面上重新啟用自己。
    if (body.active === false && id === user.id) {
      return NextResponse.json({ error: "無法停用自己的帳號（會導致自己無法再管理任何資料），請請其他管理員協助停用。" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};

    if (typeof body.role === "string") {
      if (!isAssignableStaffRole(body.role)) {
        return NextResponse.json({ error: "請選擇有效角色（管理員／訂貨管家／管家）。" }, { status: 400 });
      }
      updates.role = body.role;
    }
    if (typeof body.displayName === "string") {
      const name = body.displayName.trim();
      if (!name) return NextResponse.json({ error: "請輸入姓名。" }, { status: 400 });
      updates.display_name = name;
    }
    if (typeof body.active === "boolean") {
      if (body.active && typeof body.role !== "string") {
        // 重新啟用但沒有一併指定新角色時，先確認目前角色不是已移除的viewer。
        const { data: current, error: fetchError } = await supabase.from("staff_profiles").select("role").eq("id", id).maybeSingle();
        if (fetchError) throw fetchError;
        if (current?.role === "viewer") {
          return NextResponse.json({ error: "此帳號角色為已移除的查看者，請先指定為管理員、訂貨管家或管家後才能啟用。" }, { status: 400 });
        }
      }
      updates.active = body.active;
    }
    if (Object.keys(updates).length === 0) return NextResponse.json({ error: "沒有可更新的欄位。" }, { status: 400 });

    const { data, error } = await supabase
      .from("staff_profiles")
      .update(updates)
      .eq("id", id)
      .select("id,display_name,email,role,active,created_at");
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });
      if (error.code === "P0001") return NextResponse.json({ error: "查看者角色已移除，請改指定管理員、訂貨管家或管家。" }, { status: 400 });
      throw error;
    }
    if (!data || data.length === 0) return NextResponse.json({ error: FORBIDDEN_MESSAGE }, { status: 403 });

    return NextResponse.json({ staff: mapStaffRow(data[0]) });
  } catch (error) {
    console.error("Update staff failed", error);
    return NextResponse.json({ error: "更新員工資料失敗，請稍後再試。" }, { status: 500 });
  }
}
