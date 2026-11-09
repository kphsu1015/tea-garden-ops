"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// 「⋯」選單（庫存每列、採購卡片共用）：用畫面座標定位才不會被捲動框切掉，下方空間不夠時往上開；
// 點外面、按Esc、捲動頁面都會關掉；鍵盤上下鍵移動，Esc後游標回到「⋯」按鈕。沒權限的項目會寫出原因。
export type ActionMenuItem = { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean; note?: string; danger?: boolean; hidden?: boolean };
export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const shown = items.filter((i) => !i.hidden);
  const menuItems = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const toggleOpen = () => {
    if (open) { setOpen(false); return; }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) {
      const menuH = 12 + shown.reduce((sum, i) => sum + 38 + (i.note ? 28 : 0), 0), menuW = 196;
      const top = r.bottom + 4 + menuH > window.innerHeight ? Math.max(8, r.top - 4 - menuH) : r.bottom + 4;
      setPos({ top, left: Math.max(8, r.right - menuW) });
    }
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    menuItems()[0]?.focus({ preventScroll: true });
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = menuItems(); if (list.length === 0) return;
        e.preventDefault();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
        list[next].focus({ preventScroll: true });
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); };
  }, [open]);
  if (shown.length === 0) return null;
  return <div className="row-menu" ref={ref}>
    <button ref={triggerRef} type="button" className="row-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} title="更多操作" onClick={toggleOpen}><MoreHorizontal size={16} /></button>
    {open && <div className="row-menu-list" role="menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
      {shown.map((item) => { const Icon = item.icon; return <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""} disabled={item.disabled} onClick={() => { setOpen(false); item.onClick(); }}><Icon size={14} />{item.label}{item.note && <small>{item.note}</small>}</button>; })}
    </div>}
  </div>;
}
