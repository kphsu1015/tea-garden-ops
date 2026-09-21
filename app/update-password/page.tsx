"use client";

import { ChevronRight, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const MIN_PASSWORD_LENGTH = 12;

export default function UpdatePasswordPage() {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const supabase = createClient();
      const code = new URLSearchParams(window.location.search).get("code");
      // 忘記密碼／設定密碼信直接導回這頁，帶著一次性code；先在瀏覽器端兌換成session，
      // 換過一次就從網址上拿掉，避免使用者重新整理時重複兌換。
      const exchange = code
        ? supabase.auth.exchangeCodeForSession(code).then(() => {
            window.history.replaceState({}, "", window.location.pathname);
          }, () => {})
        : Promise.resolve();
      exchange.then(() => {
        supabase.auth.getUser().then(({ data }) => {
          setHasSession(Boolean(data.user));
          setChecking(false);
        });
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`密碼至少需要${MIN_PASSWORD_LENGTH}個字元。`);
      return;
    }
    if (password !== confirmPassword) {
      setError("兩次輸入的密碼不一致。");
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setDone(true);
      await supabase.auth.signOut();
      // 刻意用整頁重新導向（不是client router），確保signOut後所有已快取的session狀態都重新初始化。
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.setTimeout(() => { window.location.href = "/"; }, 1800);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "設定密碼失敗，請稍後再試或重新索取連結。");
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return <main className="login-page"><div className="login-panel"><div className="login-card"><p>驗證連結中…</p></div></div></main>;
  }

  if (!hasSession) {
    return <main className="login-page"><div className="login-panel"><div className="login-card">
      <div className="login-logo">茶</div><h2>連結已失效</h2>
      <p>這個設定密碼的連結不存在、已過期，或已經使用過。請重新到登入頁索取新的連結。</p>
      <Link className="primary-button" href="/">回登入頁<ChevronRight size={18} /></Link>
    </div></div></main>;
  }

  if (done) {
    return <main className="login-page"><div className="login-panel"><div className="login-card">
      <div className="login-logo">茶</div><h2>密碼設定完成</h2>
      <p>即將導回登入頁，請用新密碼重新登入。</p>
    </div></div></main>;
  }

  return <main className="login-page">
    <div className="login-art"><div className="mountains" /><div className="login-message"><span>ALISHAN · TEA GARDEN</span><h1>讓每一次補貨，<br />都比缺貨早一步。</h1><p>民宿備品、早餐、晚餐食材與交接事項，一個地方清楚掌握。</p></div></div>
    <div className="login-panel"><div className="login-card">
      <div className="login-logo">茶</div><h2>設定密碼</h2><p>請設定你的登入密碼，之後就能用Email＋密碼登入。</p>
      <form onSubmit={submit}>
        <label>新密碼
          <div className="password-field">
            <input required type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少12個字元" autoComplete="new-password" />
            <button type="button" aria-label={showPassword ? "隱藏密碼" : "顯示密碼"} title={showPassword ? "隱藏密碼" : "顯示密碼"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
        </label>
        <label>再次確認密碼
          <div className="password-field">
            <input required type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再輸入一次" autoComplete="new-password" />
          </div>
        </label>
        <ul className="password-hints">
          <li className={password.length >= MIN_PASSWORD_LENGTH ? "ok" : ""}>至少{MIN_PASSWORD_LENGTH}個字元</li>
          <li className={hasUpper && hasLower ? "ok" : ""}>建議包含英文大小寫</li>
          <li className={hasDigit ? "ok" : ""}>建議包含數字</li>
        </ul>
        {error && <div className="error-box">{error}</div>}
        <button className="primary-button" disabled={submitting}>{submitting ? "設定中…" : "設定密碼"}<ChevronRight size={18} /></button>
      </form>
    </div></div>
  </main>;
}
