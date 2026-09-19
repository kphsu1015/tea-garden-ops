import { NextResponse } from "next/server";
import { isAssignableStaffRole, mapStaffRow } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const STAFF_SELECT_COLUMNS = "id,display_name,email,role,active,created_at";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ staff: [], demo: true });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再查看員工列表。" }, { status: 401 });

  try {
    const { data, error } = await supabase
      .from("staff_profiles")
      .select(STAFF_SELECT_COLUMNS)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ staff: (data ?? []).map(mapStaffRow), demo: false });
  } catch (error) {
    console.error("List staff failed", error);
    return NextResponse.json({ error: "讀取員工列表失敗，請稍後再試。" }, { status: 500 });
  }
}

// 邀請員工：對方必須已經至少成功登入過一次（auth.users已有紀錄），
// 這裡不會、也無法建立新的登入帳號（不使用service role金鑰）。角色只能是admin／purchaser／housekeeper。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增員工。" }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "請先登入後再操作。" }, { status: 401 });

  try {
    const body = await request.json() as { email?: string; displayName?: string; role?: string };
    const email = body.email?.trim();
    if (!email) return NextResponse.json({ error: "請輸入Email。" }, { status: 400 });
    if (!body.role || !isAssignableStaffRole(body.role)) {
      return NextResponse.json({ error: "請選擇有效角色（管理員／訂貨管家／管家）。" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("invite_staff_member", {
      p_email: email,
      p_display_name: body.displayName?.trim() || null,
      p_role: body.role,
    });

    if (error) {
      if (error.code === "P0001") return NextResponse.json({ error: "只有管理員可以新增員工。" }, { status: 403 });
      if (error.code === "P0002") return NextResponse.json({ error: "找不到這個Email的帳號，請對方先使用登入連結登入一次，再邀請成為員工。" }, { status: 404 });
      throw error;
    }

    return NextResponse.json({ staff: mapStaffRow(data) }, { status: 201 });
  } catch (error) {
    console.error("Invite staff failed", error);
    return NextResponse.json({ error: "新增員工失敗，請稍後再試。" }, { status: 500 });
  }
}
