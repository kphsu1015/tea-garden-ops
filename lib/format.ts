// 畫面上顯示用的數字格式化：一律四捨五入到整數，不顯示小數點。
// 只影響「顯示」，不影響資料庫實際保存的精確值，也不影響可輸入小數的表單欄位（例如0.5公斤）。
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Math.round(value).toLocaleString("zh-TW");
}

export function formatSignedNumber(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("zh-TW")}`;
}

// 一律以Asia/Taipei當地時間判斷，不看使用者瀏覽器所在時區（例如伺服器或員工手機時區設定不同時仍一致）。
export function getTaipeiHour(date: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "numeric", hourCycle: "h23" })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? "0");
}

// 早安5:00-11:59、午安12:00-17:59、晚安18:00-4:59。
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "早安";
  if (hour >= 12 && hour < 18) return "午安";
  return "晚安";
}

export function formatTaipeiDateLabel(date: Date = new Date()): string {
  const dateFormatter = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "long", day: "numeric" });
  const weekdayFormatter = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", weekday: "long" });
  return `${dateFormatter.format(date)} · ${weekdayFormatter.format(date)}`;
}
