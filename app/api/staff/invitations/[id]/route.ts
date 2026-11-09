import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/staff-auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ONLY = "只有管理員可以處理員工邀請。";
const NOT_FOUND = "找不到這個邀請，可能對方已經完成設定，或邀請已被取消。";

// 重寄邀請信：僅管理員。寄出的仍然是Supabase官方的一次性「設定密碼」連結，對方點擊後才會成為正式員工。
export async function POST(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法寄送邀請。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;
  if (session.role !== "admin") return NextResponse.json({ error: ADMIN_ONLY }, { status: 403 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  try {
    const { data: invitation, error } = await supabase.from("staff_invitations").select("email").eq("id", id).is("accepted_at", null).maybeSingle();
    if (error) throw error;
    if (!invitation) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

    const { origin } = new URL(request.url);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: invitation.email as string,
      options: { shouldCreateUser: true, emailRedirectTo: `${origin}/auth/callback?next=/update-password` },
    });
    if (otpError) {
      // Supabase對同一個Email短時間內重複寄信有限制，把原因講清楚而不是顯示一般錯誤。
      if (otpError.status === 429) return NextResponse.json({ error: "寄信太頻繁了，請等一分鐘再試。" }, { status: 429 });
      throw otpError;
    }
    return NextResponse.json({ ok: true, email: invitation.email });
  } catch (error) {
    console.error("Resend staff invitation failed", error);
    return NextResponse.json({ error: "重寄邀請信失敗，請稍後再試。" }, { status: 500 });
  }
}

// 取消邀請：僅管理員。移除白名單後，對方即使點了信裡的連結也不會成為員工。
// 已經完成設定的邀請（accepted_at有值）不能取消，要改用「停用」。
export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法取消邀請。" }, { status: 503 });

  const session = await requireStaffSession(supabase);
  if (!session.ok) return session.response;
  if (session.role !== "admin") return NextResponse.json({ error: ADMIN_ONLY }, { status: 403 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  try {
    const { data, error } = await supabase.from("staff_invitations").delete().eq("id", id).is("accepted_at", null).select("id");
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: ADMIN_ONLY }, { status: 403 });
      throw error;
    }
    if (!data || data.length === 0) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Cancel staff invitation failed", error);
    return NextResponse.json({ error: "取消邀請失敗，請稍後再試。" }, { status: 500 });
  }
}
