// 匯出 CSV 共用：跳脫逗號／引號／換行，並擋掉 Excel 公式注入；開頭加 BOM 讓 Excel 正確顯示中文。

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  // 以 = + - @ 開頭的「文字」，Excel 會當成公式執行，前面補一個單引號擋掉（數字本身的負號不處理）。
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return "﻿" + [header.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
}

// 在瀏覽器裡把文字存成檔案下載。
export function downloadTextFile(filename: string, content: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
