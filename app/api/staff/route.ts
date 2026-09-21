import { NextResponse } from "next/server";
import { isInvitableStaffRole, mapStaffRow } from "@/lib/staff";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const STAFF_SELECT_COLUMNS = "id,display_name,email,role,active,created_at";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ staff: [], demo: true });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

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

// 邀請員工：僅admin。分兩種情況：
// 1. 對方已經至少成功登入過一次（auth.users已有紀錄）→ 直接建立/更新staff_profiles。
// 2. 對方是全新的Email（從沒登入過）→ 先寫入staff_invitations白名單，再寄出一次性「設定密碼」連結
//    （用signInWithOtp的shouldCreateUser:true讓Supabase official flow建立帳號，不使用service role金鑰）；
//    對方點擊連結、通過/auth/callback驗證後，才會正式建立staff_profiles。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法新增員工。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;

  try {
    const body = await request.json() as { email?: string; displayName?: string; role?: string };
    const email = body.email?.trim();
    if (!email) return NextResponse.json({ error: "請輸入Email。" }, { status: 400 });
    // 新員工只能指定訂貨管家或管家；管理員帳號由現有admin另外管理，不透過這裡新增。
    if (!body.role || !isInvitableStaffRole(body.role)) {
      return NextResponse.json({ error: "新增員工只能指定訂貨管家或管家，管理員帳號請由現有管理員另行指定。" }, { status: 400 });
    }
    const displayName = body.displayName?.trim() || null;

    const { data, error } = await supabase.rpc("invite_staff_member", {
      p_email: email,
      p_display_name: displayName,
      p_role: body.role,
    });

    if (!error) {
      return NextResponse.json({ staff: mapStaffRow(data), invited: false }, { status: 201 });
    }
    if (error.code === "P0001") return NextResponse.json({ error: "只有管理員可以新增員工。" }, { status: 403 });
    if (error.code !== "P0002") throw error;

    // P0002：對方還沒有auth.users帳號，改走「白名單＋寄送設定密碼連結」。
    const { error: inviteError } = await supabase
      .from("staff_invitations")
      .upsert({ email: email.toLowerCase(), display_name: displayName, role: body.role, invited_by: session.userId, accepted_at: null }, { onConflict: "email" });
    if (inviteError) {
      if (inviteError.code === "42501") return NextResponse.json({ error: "只有管理員可以新增員工。" }, { status: 403 });
      throw inviteError;
    }

    const { origin } = new URL(request.url);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: `${origin}/auth/callback?next=/update-password` },
    });
    if (otpError) throw otpError;

    return NextResponse.json({ invited: true, email }, { status: 202 });
  } catch (error) {
    console.error("Invite staff failed", error);
    return NextResponse.json({ error: "新增員工失敗，請稍後再試。" }, { status: 500 });
  }
}
