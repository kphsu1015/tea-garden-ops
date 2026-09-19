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
