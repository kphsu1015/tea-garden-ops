import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { checkStaffSession, GENERIC_LOGIN_ERROR, UNAUTHORIZED_MESSAGE } from "@/lib/staff-auth";

export const runtime = "nodejs";

// Email＋密碼登入。密碼完全交給Supabase Auth的signInWithPassword驗證，這裡不比對、不保存密碼，
// 也不會把密碼寫進任何log。
// - 帳密本身錯誤（Supabase拒絕）→ 統一顯示帳密錯誤訊息（401），不透露Email是否存在，避免被拿來列舉員工名單。
// - 帳密正確但staff_profiles查不到、Email不一致、被停用或角色無效 → 立刻signOut，顯示「尚未獲授權」訊息（403）。
//   這裡可以用比較明確的訊息，因為對方已經證明自己知道正確密碼，不會額外洩漏「這組帳密是否有效」以外的資訊。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "尚未設定Supabase，無法登入。" }, { status: 503 });

  const ip = getClientIp(request);

  try {
    const body = await request.json() as { email?: string; password?: string };
    const email = body.email?.trim();
    const password = body.password;
    if (!email || !password) return NextResponse.json({ error: GENERIC_LOGIN_ERROR }, { status: 400 });

    const ipLimit = checkRateLimit(`login:ip:${ip}`, 10 * 60_000, 20);
    const emailLimit = checkRateLimit(`login:email:${email.toLowerCase()}`, 10 * 60_000, 8);
    const retryAfter = Math.max(ipLimit ?? 0, emailLimit ?? 0);
    if (retryAfter > 0) {
      return NextResponse.json(
        { error: `嘗試次數過多，請於${retryAfter}秒後再試。` },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      return NextResponse.json({ error: GENERIC_LOGIN_ERROR }, { status: 401 });
    }

    const check = await checkStaffSession(supabase);
    if (!check.ok) {
      await supabase.auth.signOut();
      return NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 403 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Login failed", error);
    return NextResponse.json({ error: GENERIC_LOGIN_ERROR }, { status: 500 });
  }
}
