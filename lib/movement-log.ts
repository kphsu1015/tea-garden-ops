import type { StockMovementRecord } from "@/lib/movements";

// 異動紀錄頁用的純函式（日期分組、日期範圍、推算庫存、匯出 CSV），一律以 Asia/Taipei 為準。

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function taipeiDateKeyOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// 只顯示時間（HH:mm）。日期由「日期分組標題」顯示，每一列不用重複。
export function formatMovementTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 「今天」「昨天」或「11/07（五）」；不是今年的加上年份。
export function dayLabel(key: string, todayKey: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const base = `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}（${weekday}）`;
  const diff = dayNumber(todayKey) - dayNumber(key);
  if (diff === 0) return `今天　${base}`;
  if (diff === 1) return `昨天　${base}`;
  return y === Number(todayKey.slice(0, 4)) ? base : `${y}/${base}`;
}

export type DayGroup = { key: string; rows: StockMovementRecord[] };

// 依「台北當天」分組，維持原本由新到舊的順序。
export function groupByDay(rows: StockMovementRecord[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const key = taipeiDateKeyOf(row.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row); else groups.push({ key, rows: [row] });
  }
  return groups;
}

export type RangePreset = "all" | "today" | "7d" | "30d";

export function presetRange(preset: RangePreset, todayKey: string): { from: string; to: string } {
  if (preset === "today") return { from: todayKey, to: todayKey };
  if (preset === "7d") return { from: addDaysToKey(todayKey, -6), to: todayKey };
  if (preset === "30d") return { from: addDaysToKey(todayKey, -29), to: todayKey };
  return { from: "", to: "" };
}

export function detectPreset(from: string, to: string, todayKey: string): RangePreset | null {
  for (const preset of ["all", "today", "7d", "30d"] as const) {
    const r = presetRange(preset, todayKey);
    if (r.from === from && r.to === to) return preset;
  }
  return null;
}

// 翻頁游標的時間（資料庫回傳的 created_at，帶微秒與時區）。游標會被放進篩選語法，所以只接受嚴格的格式。
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/;
export function isCursorTimestamp(value: string): boolean { return CURSOR_AT_RE.test(value); }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateKey(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // 2026-02-30 這種不存在的日期會被自動換成 3 月 2 日，換回來對不上就是無效日期。
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// 台北當天 00:00:00 轉成資料庫比較用的時間。結束日要用「小於隔天 00:00」，不要用 23:59:59.999（資料庫有微秒）。
export function taipeiDayStartIso(key: string): string { return `${key}T00:00:00+08:00`; }
export function taipeiNextDayStartIso(key: string): string { return taipeiDayStartIso(addDaysToKey(key, 1)); }

// 單一品項時，用「目前庫存」往回推每一筆異動之後剩多少：越新的越先算。
// rows 必須是由新到舊、而且包含這個品項所有比它們更新的異動（沒有截止日期篩選、沒有類型篩選）。
// 同一次操作（例如跨批次領用、盤點）會在同一個時間寫入好幾筆，哪一筆先寫入無法分辨，
// 所以這種「同一時間」的一組只在最上面那一筆顯示操作完之後的庫存，其餘回傳 null（畫面顯示「〃」）。
export function balancesAfter(rows: StockMovementRecord[], currentQuantity: number): Map<string, number | null> {
  const result = new Map<string, number | null>();
  let running = currentQuantity;
  let i = 0;
  while (i < rows.length) {
    let j = i;
    let groupChange = 0;
    while (j < rows.length && rows[j].createdAt === rows[i].createdAt) { groupChange += rows[j].quantityChange; j++; }
    result.set(rows[i].id, Math.round(running * 100) / 100);
    for (let k = i + 1; k < j; k++) result.set(rows[k].id, null);
    running -= groupChange;
    i = j;
  }
  return result;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  // 以 = + - @ 開頭的文字，Excel 會當成公式執行，前面補一個單引號擋掉。
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function movementsToCsv(rows: StockMovementRecord[]): string {
  const header = ["日期", "時間", "品項", "異動類型", "數量變化", "單位", "批次到期日", "操作人", "備註"];
  const lines = rows.map((m) => [taipeiDateKeyOf(m.createdAt), formatMovementTime(m.createdAt), m.itemName, m.movementType, m.quantityChange, m.unit, m.expiryDate, m.operatorName, m.note].map(csvCell).join(","));
  // 開頭加 BOM，Excel 才會正確顯示中文。
  return "﻿" + [header.join(","), ...lines].join("\r\n");
}
