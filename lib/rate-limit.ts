// 簡易記憶體流量限制，依key（例如ip、ip+email）計算時間窗內的請求次數。
// 注意：僅限單一伺服器行程有效，多執行個體（例如Serverless多實例）不會共用計數；
// 這是在Supabase本身的Auth流量限制之外，額外加的一層節流。
const buckets = new Map<string, number[]>();

export function checkRateLimit(key: string, windowMs: number, max: number): number | null {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    return Math.ceil((windowMs - (now - recent[0])) / 1000);
  }
  recent.push(now);
  buckets.set(key, recent);
  return null;
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}
