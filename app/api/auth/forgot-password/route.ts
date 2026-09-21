import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { GENERIC_RESET_MESSAGE } from "@/lib/staff-auth";

export const runtime = "nodejs";

// 忘記密碼／第一次設定密碼共用這支：都是呼叫Supabase的resetPasswordForEmail寄一次性連結。
// 不管Email是否存在、是否在白名單，一律回傳同一句訊息，避免外人靠回應內容判斷哪些Email是員工。
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ message: GENERIC_RESET_MESSAGE });

  const ip = getClientIp(request);

  try {
    const body = await request.json() as { email?: string };
    const email = body.email?.trim();
    if (!email) return NextResponse.json({ message: GENERIC_RESET_MESSAGE });

    const ipLimit = checkRateLimit(`reset:ip:${ip}`, 15 * 60_000, 10);
    const emailLimit = checkRateLimit(`reset:email:${email.toLowerCase()}`, 15 * 60_000, 3);
    if (Math.max(ipLimit ?? 0, emailLimit ?? 0) > 0) {
      // 就算被限流也回傳同一句話，不額外透露「這個Email剛剛被大量嘗試過」這種資訊。
      return NextResponse.json({ message: GENERIC_RESET_MESSAGE });
    }

    const { origin } = new URL(request.url);
    // 直接導回/update-password（不經過/auth/callback），對方點連結後由該頁自己在瀏覽器端交換code、
    // 建立session；這裡不需要、也不會提前知道對方是誰。
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/update-password`,
    });
    if (error) console.error("Reset password request failed", error.message);
  } catch (error) {
    console.error("Reset password request error", error);
  }

  return NextResponse.json({ message: GENERIC_RESET_MESSAGE });
}
