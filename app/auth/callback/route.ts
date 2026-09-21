import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkStaffSession } from "@/lib/staff-auth";

export const runtime = "nodejs";

// 處理三種來源的連結：管理員備用登入的Magic Link、忘記密碼／第一次設定密碼的重設連結（next=/update-password）、
// 員工邀請信（同樣是OTP連結，next=/update-password）。全部都要通過Supabase官方的code交換，
// 交換成功後才視為「已驗證」；接著嘗試兌換待處理的員工邀請，最後一定要重新確認白名單資格，
// 不符合就立刻signOut並導回登入頁、不放行進入系統。
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");
  const safeNext = next === "/update-password" ? "/update-password" : "/";

  const supabase = await createClient();
  if (!code || !supabase) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  // 如果這個Email剛好有待處理的員工邀請，就在這裡正式建立staff_profiles；沒有邀請時忽略錯誤即可
  // （代表這只是一般管理員備用登入或密碼重設，不是邀請流程）。
  await supabase.rpc("accept_staff_invitation").then(
    () => {},
    () => {},
  );

  const check = await checkStaffSession(supabase);
  if (!check.ok) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/?auth_error=unauthorized`);
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}
