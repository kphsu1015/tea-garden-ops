"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 對話框的鍵盤處理：開啟時焦點放在 data-autofocus 的元素（沒有就放第一個可聚焦的），
// Tab 只會在對話框裡循環，按 Esc 關閉（處理中不能關），關閉後焦點回到原本按下的按鈕。
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void, isBusy: () => boolean) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = () => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    (dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isBusy()) { onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !dialog?.contains(current))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (current === last || !dialog?.contains(current))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.(); };
    // 只在對話框開啟時設定一次；onClose／isBusy 每次渲染都是新函式，不放進依賴。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
