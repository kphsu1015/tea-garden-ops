"use client";

import {
  AlertTriangle, Archive, BarChart3, Bell, Box, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardCheck, Download, ClipboardList, RefreshCw,
  Clock3, Eye, EyeOff, FileScan, History, LogOut, Menu, MessageSquareText, Pencil, Plus, Power, Search, Settings,
  MoreHorizontal, PauseCircle, ShoppingCart, Trash2, Undo2, Users, X
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { initialNotes, initialPurchases } from "@/lib/demo-data";
import { EXPIRY_WARNING_DAYS, estimatedRemainingLabel, expiryLabel, getExpiringBatches, getLowStockReason, isLargeStockDiff, lowStockReasonLabel, MOVEMENT_TYPE_DEFAULT_DIRECTION, MOVEMENT_TYPE_ENUM, MOVEMENT_TYPE_LABELS, periodFrequencyLabel, restoreCounts, roundQuantity, taipeiDateKey, type ExpiringBatch, type StocktakeCount } from "@/lib/inventory";
import type { StockMovementRecord } from "@/lib/movements";
import { balancesAfter, dayLabel, detectPreset, formatMovementTime, groupByDay, movementsToCsv, presetRange } from "@/lib/movement-log";
import { formatNumber, formatSignedNumber, formatTaipeiDateLabel, getTaipeiHour, greetingForHour } from "@/lib/format";
import { generateId } from "@/lib/id";
import { staffRoleLabel } from "@/lib/staff";
import { PurchaseReportView } from "@/components/purchase-report-view";
import { ReceiptScanner } from "@/components/receipt-scanner";
import { SettingsView } from "@/components/settings-view";
import { StaffView } from "@/components/staff-view";
import { requestJson, usePolling, useSharedData } from "@/components/use-shared-data";
import { createClient } from "@/lib/supabase/client";
import type { AssignableStaffRole, HandoverNote, InventoryBatch, InventoryCategory, InventoryItem, InventoryItemInput, MovementType, NoteDraft, PurchaseDraft, PurchaseRequest, PurchaseStatus, ReceiptRecord, UsagePeriod } from "@/lib/types";

type View = "dashboard" | "inventory" | "purchases" | "receipts" | "movement-log" | "report" | "notes" | "staff" | "settings";
type Modal = "purchase" | "movement" | "item" | "note" | null;

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
);

function useSupabaseSession() {
  const [status, setStatus] = useState<"loading" | "authed" | "anon">(supabaseConfigured ? "loading" : "anon");
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;
    const supabase = createClient();
    let active = true;

    const timer = window.setTimeout(() => {
      supabase.auth.getUser().then(({ data }) => {
        if (!active) return;
        setEmail(data.user?.email ?? null);
        setUserId(data.user?.id ?? null);
        setStatus(data.user ? "authed" : "anon");
      });
    }, 0);

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
      setUserId(session?.user?.id ?? null);
      setStatus(session?.user ? "authed" : "anon");
    });

    return () => {
      active = false;
      window.clearTimeout(timer);
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    if (!supabaseConfigured) return;
    const supabase = createClient();
    await supabase.auth.signOut();
  };

  return { configured: supabaseConfigured, status, email, userId, signOut };
}

function useStaffRole(session: ReturnType<typeof useSupabaseSession>) {
  const [role, setRole] = useState<AssignableStaffRole | null>(null);
  // checked：是否已經完成過一次「這個已登入帳號到底有沒有有效角色」的確認，
  // 用來避免role還沒查完之前就誤判成「已確認無角色」而把使用者登出。
  const [checked, setChecked] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!session.configured || session.status !== "authed" || !session.userId) {
        if (active) { setRole(null); setChecked(false); setDisplayName(null); }
        return;
      }
      const supabase = createClient();
      supabase.from("staff_profiles").select("email,role,active,display_name").eq("id", session.userId as string).maybeSingle().then(({ data, error }) => {
        if (!active) return;
        // 讀不到自己的staff_profiles常見原因：這個帳號的active目前是false（is_active_staff()連自己的row都讀不到）。
        if (error) console.error("Load staff role failed", error);
        // 前端這裡跟後端checkStaffSession用同一套規則：Email要跟目前登入的Email一致、active為true、
        // 角色只能是admin／purchaser／housekeeper（viewer已移除且會被停用）。任何一項不符就視為無效。
        const emailMatches = Boolean(data?.email && session.email && data.email.toLowerCase() === session.email.toLowerCase());
        const validRole = data?.active && emailMatches && (data.role === "admin" || data.role === "purchaser" || data.role === "housekeeper")
          ? (data.role as AssignableStaffRole)
          : null;
        setRole(validRole);
        setChecked(true);
        setDisplayName(validRole ? (data?.display_name || null) : null);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session.configured, session.status, session.userId, session.email]);

  return { role, checked, displayName, setDisplayName };
}

function useCategories() {
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  // 品項或進貨明細用到、但不在分類清單裡的名稱（例如早期改名沒有連動留下的舊名稱）。
  const [orphans, setOrphans] = useState<Array<{ name: string; itemCount: number; receiptLineCount: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  // silent：背景同步時不顯示「載入中」，失敗也不蓋掉畫面上已有的資料。
  // reportFailure：操作成功後的重新讀取失敗時，也要告訴使用者畫面可能不是最新的（背景同步則不打擾）。
  const refresh = async (silent = false, reportFailure = false) => {
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch("/api/categories");
      const data = await response.json() as { categories?: InventoryCategory[]; orphans?: Array<{ name: string; itemCount: number; receiptLineCount: number }>; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取分類失敗");
      setCategories(data.categories || []);
      setOrphans(data.orphans || []);
      setDemo(Boolean(data.demo));
      setError("");
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : "讀取分類失敗，請稍後再試。");
      else if (reportFailure) setError("剛剛的操作已經完成，但重新載入分類失敗，畫面上的資料可能不是最新的。");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const mutate = async (request: () => Promise<Response>): Promise<string | void> => {
    try {
      const response = await request();
      const data = await response.json() as { error?: string };
      if (!response.ok) return data.error || "操作失敗，請稍後再試。";
      await refresh(true, true);
    } catch (reason) {
      return reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
    }
  };

  const addCategory = (name: string) => mutate(() => fetch("/api/categories", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }));

  const renameCategory = (id: string, name: string) => mutate(() => fetch(`/api/categories/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  }));

  const toggleCategoryActive = (id: string, active: boolean) => mutate(() => fetch(`/api/categories/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }),
  }));

  const deleteCategory = (id: string) => mutate(() => fetch(`/api/categories/${id}`, { method: "DELETE" }));

  // 一次送出所有分類的新順序，由資料庫函式在單一交易內整批更新（不會出現兩個分類順序相同）。
  const reorderCategories = (ids: string[]) => mutate(() => fetch("/api/categories/reorder", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  }));

  return { categories, orphans, loading, error, demo, addCategory, renameCategory, toggleCategoryActive, deleteCategory, reorderCategories, refresh };
}

function useInventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  // 最新一次讀到的庫存：存完盤點／異動後要馬上拿到新數字（做提示與復原），不用等畫面重新渲染。
  const itemsRef = useRef<InventoryItem[]>([]);
  // 最近一次重新讀取有沒有成功：失敗時 itemsRef 是舊資料，不能拿來做復原。
  const freshRef = useRef(false);

  const refresh = async (silent = false) => {
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch("/api/inventory");
      const data = await response.json() as { items?: InventoryItem[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取庫存失敗");
      itemsRef.current = data.items || [];
      freshRef.current = true;
      setItems(data.items || []);
      setDemo(Boolean(data.demo));
      setError("");
    } catch (reason) {
      freshRef.current = false;
      if (!silent) setError(reason instanceof Error ? reason.message : "讀取庫存失敗，請稍後再試。");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // 存完後安靜地重新讀取：不切到「載入中」，表格不會閃一下、整批盤點填到一半的內容也不會不見。
  const mutate = async (request: () => Promise<Response>, reload = true): Promise<string | void> => {
    try {
      const response = await request();
      const data = await response.json() as { error?: string };
      if (!response.ok) return data.error || "操作失敗，請稍後再試。";
      if (reload) await refresh(true);
    } catch (reason) {
      return reason instanceof Error ? reason.message : "操作失敗，請稍後再試。";
    }
  };

  const addItem = (payload: InventoryItemInput) => mutate(() => fetch("/api/inventory", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));

  const updateItem = (id: string, payload: Partial<InventoryItemInput>) => mutate(() => fetch(`/api/inventory/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));

  const setItemActive = (id: string, active: boolean) => mutate(() => fetch(`/api/inventory/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }),
  }));

  const deleteItem = (id: string) => mutate(() => fetch(`/api/inventory/${id}`, { method: "DELETE" }));

  // 給「新增採購需求」在挑不到現有品項時直接建立新品項用：跟addItem用同一支API，
  // 但這裡需要拿到剛建立品項的id（用來當這筆採購需求的inventoryItemId），所以另外寫一支、不影響addItem原本的呼叫端。
  const createAndReturnItem = async (payload: InventoryItemInput): Promise<InventoryItem | string> => {
    try {
      const response = await fetch("/api/inventory", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json() as { item?: InventoryItem; error?: string };
      if (!response.ok || !data.item) return data.error || "新增品項失敗，請稍後再試。";
      await refresh();
      return data.item;
    } catch (reason) {
      return reason instanceof Error ? reason.message : "新增品項失敗，請稍後再試。";
    }
  };

  // 盤點／修正庫存、新增庫存異動：都透過record_stock_movement()交易函式寫入，quantity會是伺服器端的真實新值，
  // mutate內建的refresh()結束後items會拿到正確數量，不需要再手動調整。
  // batch.batchId：減少時指定扣哪一批（不填就先到期先出）；batch.expiryDate：增加時新庫存的到期日。
  const countStock = (id: string, changeAmount: number, note?: string, movementType?: string, batch?: { batchId?: string; expiryDate?: string }) => mutate(() => fetch(`/api/inventory/${id}/count`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changeAmount, note, movementType, ...batch }),
  }));

  // 依批次盤點：一次送出每一批的實際數量，伺服器在同一個交易內修正。
  // reload=false 給整批盤點用：一項一項送完再統一重新讀取一次。
  const stocktake = (id: string, counts: StocktakeCount[], note?: string, reload = true) => mutate(() => fetch(`/api/inventory/${id}/stocktake`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ counts, note }),
  }), reload);

  const getItem = (id: string) => itemsRef.current.find((item) => item.id === id);
  // 先重新讀一次再回傳最新品項；讀取失敗回傳 null。
  const fetchItem = async (id: string) => { await refresh(true); return freshRef.current ? getItem(id) ?? null : null; };
  const isFresh = () => freshRef.current;

  return { items, loading, error, demo, addItem, updateItem, setItemActive, deleteItem, countStock, stocktake, refresh, createAndReturnItem, getItem, fetchItem, isFresh };
}

const navItems: Array<{ id: View; label: string; icon: typeof Box }> = [
  { id: "dashboard", label: "總覽", icon: Box },
  { id: "inventory", label: "庫存管理", icon: Archive },
  { id: "purchases", label: "採購需求", icon: ShoppingCart },
  { id: "receipts", label: "新增進貨單", icon: FileScan },
  { id: "movement-log", label: "異動紀錄", icon: History },
  { id: "report", label: "進貨報表", icon: BarChart3 },
  { id: "notes", label: "交接留言", icon: MessageSquareText },
  { id: "staff", label: "員工管理", icon: Users },
];

const EXPIRY_WINDOW_LABEL = `${EXPIRY_WARNING_DAYS}天`;

const statusSteps: PurchaseStatus[] = ["待確認", "已訂購", "已到貨", "已入庫"];

function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(key);
      if (saved) {
        try { setValue(JSON.parse(saved) as T); } catch { /* ignore invalid demo data */ }
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    if (hydrated) window.localStorage.setItem(key, JSON.stringify(value));
  }, [hydrated, key, value]);
  return [value, setValue] as const;
}

function Pill({ children, tone = "sage" }: { children: React.ReactNode; tone?: "sage" | "gold" | "red" | "blue" | "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function OperationsApp() {
  const session = useSupabaseSession();
  const roleState = useStaffRole(session);
  const role = roleState.role;
  const [demoLoggedIn, setDemoLoggedIn] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [view, setView] = useState<View>("dashboard");
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<InventoryItem | null>(null);
  const [countingItem, setCountingItem] = useState<InventoryItem | null>(null);
  const [movingItem, setMovingItem] = useState<InventoryItem | null>(null);
  const [stockNotice, setStockNotice] = useState<StockNotice | null>(null);
  const [deletingNote, setDeletingNote] = useState<HandoverNote | null>(null);
  const [editingNote, setEditingNote] = useState<HandoverNote | null>(null);
  // 交接留言頁上方的提示：新增／編輯／刪除成功，或失敗；刪除後可以復原。
  const [noteNotice, setNoteNotice] = useState<NoteNotice | null>(null);
  // 新增留言後把留言頁的篩選重設（回到「未處理」、全部分類、清掉搜尋），不然新留言可能被目前的篩選藏起來。
  const [notesViewKey, setNotesViewKey] = useState(0);
  const [query, setQuery] = useState("");
  // 庫存頁的篩選：從總覽點「低庫存」「即將過期」進來時直接套用；從側邊選單進來回到「全部」。
  const [inventoryFilter, setInventoryFilter] = useState<StockFilter>("all");
  // 使用者在總覽按「重新整理」：這段期間總覽一律顯示載入中，不顯示舊的或0的數字。
  const [retrying, setRetrying] = useState(false);
  const inventoryState = useInventory();
  const categoryState = useCategories();

  // 採購需求、交接留言、進貨單、保存天數：已設定Supabase時全部讀寫資料庫，所有員工看到同一份，
  // 並每30秒／切回分頁時自動更新；未設定Supabase的離線示範模式才退回各瀏覽器自己的localStorage。
  const sharedEnabled = session.configured && session.status === "authed";
  const [localPurchases, setLocalPurchases] = useStoredState("tea-purchases", initialPurchases);
  const [localNotes, setLocalNotes] = useStoredState("tea-notes", initialNotes);
  const [localReceipts, setLocalReceipts] = useStoredState<ReceiptRecord[]>("tea-receipts", []);
  const [localRetentionDays, setLocalRetentionDays] = useStoredState("tea-receipt-retention", 90);
  const purchasesState = useSharedData<PurchaseRequest[]>({ url: "/api/purchases", field: "purchases", enabled: sharedEnabled });
  const notesState = useSharedData<HandoverNote[]>({ url: "/api/notes", field: "notes", enabled: sharedEnabled });
  const receiptsState = useSharedData<ReceiptRecord[]>({ url: "/api/receipts", field: "receipts", enabled: sharedEnabled });
  const settingsState = useSharedData<number>({ url: "/api/settings", field: "receiptRetentionDays", enabled: sharedEnabled });
  usePolling(() => { inventoryState.refresh(true); categoryState.refresh(true); }, sharedEnabled);

  const purchases = session.configured ? (purchasesState.data ?? []) : localPurchases;
  const notes = session.configured ? (notesState.data ?? []) : localNotes;
  const receipts = session.configured ? (receiptsState.data ?? []) : localReceipts;
  const retentionDays = session.configured ? (settingsState.data ?? 90) : localRetentionDays;

  const addPurchase = async (draft: PurchaseDraft): Promise<string | void> => {
    if (!session.configured) {
      setLocalPurchases([{ id: generateId(), ...draft, status: "待確認", requester: "Alan", requestedAt: new Date().toLocaleString("zh-TW", { hour12: false }) }, ...localPurchases]);
      return;
    }
    const error = await requestJson("/api/purchases", "POST", draft);
    if (error) return error;
    await purchasesState.refresh(true);
  };
  const advancePurchase = async (id: string, status: PurchaseStatus): Promise<string | void> => {
    if (!session.configured) {
      setLocalPurchases(localPurchases.map((r) => r.id === id ? { ...r, status } : r));
      return;
    }
    const error = await requestJson(`/api/purchases/${id}`, "PATCH", { status });
    if (error) return error;
    await purchasesState.refresh(true);
  };
  const setPurchasePriority = async (id: string, priority: PurchaseRequest["priority"]): Promise<string | void> => {
    if (!session.configured) {
      setLocalPurchases(localPurchases.map((r) => r.id === id ? { ...r, priority } : r));
      return;
    }
    const error = await requestJson(`/api/purchases/${id}`, "PATCH", { priority });
    if (error) return error;
    await purchasesState.refresh(true);
  };
  const editPurchase = async (id: string, patch: { quantity: number; note: string }): Promise<string | void> => {
    if (!session.configured) {
      setLocalPurchases(localPurchases.map((r) => r.id === id ? { ...r, quantity: patch.quantity, note: patch.note.trim() || undefined } : r));
      return;
    }
    const error = await requestJson(`/api/purchases/${id}`, "PATCH", { quantity: patch.quantity, note: patch.note });
    if (error) return error;
    await purchasesState.refresh(true);
  };
  const addNote = async (draft: NoteDraft): Promise<string | void> => {
    if (!session.configured) {
      setLocalNotes([{ id: generateId(), ...draft, author: "Alan", createdAt: new Date().toLocaleString("zh-TW", { hour12: false }) }, ...localNotes]);
      return;
    }
    const error = await requestJson("/api/notes", "POST", draft);
    if (error) return error;
    await notesState.refresh(true);
  };
  const editNote = async (id: string, draft: NoteDraft): Promise<string | void> => {
    if (!session.configured) {
      setLocalNotes(localNotes.map((n) => n.id === id ? { ...n, ...draft, editedAt: new Date().toLocaleString("zh-TW", { hour12: false }) } : n));
      return;
    }
    const error = await requestJson(`/api/notes/${id}`, "PATCH", { action: "edit", ...draft });
    if (error) return error;
    await notesState.refresh(true);
  };
  const resolveNote = async (id: string, resolved: boolean): Promise<string | void> => {
    if (!session.configured) {
      setLocalNotes(localNotes.map((n) => n.id === id ? { ...n, resolvedAt: resolved ? new Date().toLocaleString("zh-TW", { hour12: false }) : null, resolvedBy: resolved ? "Alan" : null } : n));
      return;
    }
    const error = await requestJson(`/api/notes/${id}`, "PATCH", { action: resolved ? "resolve" : "reopen" });
    if (error) return error;
    await notesState.refresh(true);
  };
  // 刪除是軟刪除（資料還在，只是不顯示），所以可以復原。
  const deleteNote = async (note: HandoverNote): Promise<string | void> => {
    if (!session.configured) {
      setLocalNotes(localNotes.filter((n) => n.id !== note.id));
    } else {
      const error = await requestJson(`/api/notes/${note.id}`, "DELETE");
      if (error) return error;
      await notesState.refresh(true);
    }
    const restore = async (): Promise<string | void> => {
      if (!session.configured) {
        setLocalNotes((current) => current.some((n) => n.id === note.id) ? current : [note, ...current]);
        return;
      }
      const error = await requestJson(`/api/notes/${note.id}`, "PATCH", { action: "restore" });
      if (error) return error;
      await notesState.refresh(true);
    };
    setNoteNotice({ message: "已刪除這則留言。", restore });
  };
  const changeRetentionDays = async (days: number): Promise<string | void> => {
    if (!session.configured) {
      setLocalRetentionDays(days);
      return;
    }
    const error = await requestJson("/api/settings", "PATCH", { receiptRetentionDays: days });
    if (error) return error;
    await settingsState.refresh(true);
  };

  // 即使Supabase Auth登入成功，只要不在白名單、被停用或角色無效，就立刻登出、拒絕進入系統，
  // 不能只是把畫面上的按鈕都鎖住而已。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (session.configured && session.status === "authed" && roleState.checked && roleState.role === null) {
        setRejected(true);
        session.signOut();
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.configured, session.status, roleState.checked, roleState.role]);

  const inventory = inventoryState.items;
  const activeInventory = useMemo(() => inventory.filter((item) => item.active), [inventory]);
  const canManageItems = role === "admin" || role === "purchaser";
  // 重新啟用停用品項、永久刪除品項：管理員與訂貨管家（需先在Supabase執行 0016 migration）。
  const canReactivateOrDeleteItems = role === "admin" || role === "purchaser";
  const canCountStock = role === "admin" || role === "purchaser" || role === "housekeeper";
  const canViewPurchaseReport = role === "admin" || role === "purchaser";

  const activeCategoryNames = useMemo(() => categoryState.categories.filter((c) => c.active).map((c) => c.name), [categoryState.categories]);
  const filterCategoryNames = useMemo(() => Array.from(new Set([
    ...[...categoryState.categories].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => c.name),
    ...inventory.map((item) => item.category),
  ])), [categoryState.categories, inventory]);
  const itemFormCategoryOptions = useMemo(() => {
    if (!editingItem || activeCategoryNames.includes(editingItem.category)) return activeCategoryNames;
    return [editingItem.category, ...activeCategoryNames];
  }, [activeCategoryNames, editingItem]);

  const lowStock = useMemo(() => activeInventory.filter((item) => getLowStockReason(item) !== null), [activeInventory]);
  const expiring = useMemo(() => getExpiringBatches(activeInventory, taipeiDateKey()), [activeInventory]);
  const pending = purchases.filter((request) => !["已入庫", "暫緩"].includes(request.status));

  // 總覽的資料狀態（每個資料來源各自判斷）：還沒載入完、使用者按了重新整理、或載入失敗時，那一塊不顯示數字，
  // 避免誤以為「今天沒事」。背景輪詢的靜默更新不算載入中，畫面不會一直閃。
  const sourceStatus = (loading: boolean, hasData: boolean, error: string): SourceStatus => ({ loading: retrying || (loading && !hasData), failed: Boolean(error) && !retrying });
  const dashboardStatus = {
    inventory: sourceStatus(inventoryState.loading, inventory.length > 0, inventoryState.error),
    purchases: session.configured ? sourceStatus(purchasesState.loading, Boolean(purchasesState.data), purchasesState.error) : { loading: false, failed: false },
    notes: session.configured ? sourceStatus(notesState.loading, Boolean(notesState.data), notesState.error) : { loading: false, failed: false },
  };
  const retryDashboard = async () => {
    setRetrying(true);
    try { await Promise.all([inventoryState.refresh(), ...(session.configured ? [purchasesState.refresh(), notesState.refresh()] : [])]); }
    finally { setRetrying(false); }
  };
  // 盤點／異動存完：記下改之前和改之後，列表上方顯示改了多少，並且可以復原。
  // 存之前先重新讀一次當作「改之前」，存完再讀一次當作「改之後」；任一次讀取失敗就只說已儲存、不給復原。
  const STALE_NOTICE: StockNotice = { title: "已儲存，但重新讀取庫存失敗，請重新整理頁面確認數字。", changes: [], stale: true };
  const recordStockChange = async (item: InventoryItem, title: string, run: () => Promise<string | void>) => {
    const before = await inventoryState.fetchItem(item.id);
    const err = await run();
    if (err) return err;
    const after = inventoryState.isFresh() ? inventoryState.getItem(item.id) : undefined;
    setStockNotice(before && after ? { title, changes: [{ before, after }] } : STALE_NOTICE);
  };
  // 整批盤點：一項一項送（每項各自一個交易），送完統一重新讀取；回傳失敗的品項與原因，讓畫面留著讓員工改。
  const bulkStocktake = async (entries: Array<{ item: InventoryItem; counts: StocktakeCount[] }>, note?: string) => {
    const failed: Record<string, string> = {};
    await inventoryState.refresh(true);
    const startFresh = inventoryState.isFresh();
    const befores: InventoryItem[] = [];
    for (const { item, counts } of entries) {
      const before = inventoryState.getItem(item.id) ?? item;
      const err = await inventoryState.stocktake(item.id, counts, note, false);
      if (err) failed[item.id] = err; else befores.push(before);
    }
    await inventoryState.refresh(true);
    if (befores.length > 0) {
      const changes = befores.flatMap((before) => { const after = inventoryState.getItem(before.id); return after ? [{ before, after }] : []; });
      setStockNotice(startFresh && inventoryState.isFresh() ? { title: `已盤點 ${changes.length} 項`, changes } : STALE_NOTICE);
    }
    return failed;
  };
  // 復原：先讀最新數字，再把這一次的變動反過來做（見 restoreCounts），中間別人做的領用、入庫會保留。
  // 別人已經把這次加的量用掉（會變負數）就不自動復原，請員工用盤點改。
  const undoStockChange = async () => {
    if (!stockNotice) return;
    await inventoryState.refresh(true);
    if (!inventoryState.isFresh()) { setStockNotice({ ...stockNotice, error: "讀不到最新庫存，請檢查網路後再試一次。", canRetry: true }); return; }
    const failed: StockChange[] = [];
    let firstError = "";
    let conflict = false;
    for (const change of stockNotice.changes) {
      const current = inventoryState.getItem(change.after.id);
      const counts = current ? restoreCounts(change.before, change.after, current) : null;
      if (!current || counts === null) {
        failed.push(change);
        conflict = true;
        firstError ||= `「${change.after.name}」之後又被用掉或刪除，沒辦法自動復原，請用「盤點」改成正確數量。`;
        continue;
      }
      if (counts.length === 0) continue;
      const err = await inventoryState.stocktake(current.id, counts, "復原上一次的修改", false);
      if (err) { failed.push(change); firstError ||= err; }
    }
    await inventoryState.refresh(true);
    setStockNotice(failed.length > 0
      ? { ...stockNotice, changes: failed, error: firstError, canRetry: !conflict }
      : { title: "已復原", changes: stockNotice.changes, undone: true });
  };
  const openPurchaseModal = (initialItem?: string) => {
    // 沒有現有庫存品項也能開啟：現在「新增採購需求」本身就能順手建立新庫存品項，不用先跳去庫存頁新增。
    if (initialItem) setQuery(initialItem);
    setModal("purchase");
  };

  const isLoggedIn = session.configured
    ? session.status === "authed" && roleState.checked && roleState.role !== null
    : demoLoggedIn;
  if (session.configured && session.status === "loading") {
    return <main className="login-page"><div className="login-panel"><div className="login-card"><p>載入登入狀態中…</p></div></div></main>;
  }
  if (session.configured && session.status === "authed" && (!roleState.checked || roleState.role === null)) {
    return <main className="login-page"><div className="login-panel"><div className="login-card"><p>驗證員工身分中…</p></div></div></main>;
  }
  if (!isLoggedIn) return <LoginScreen supabaseConfigured={session.configured} onDemoLogin={() => setDemoLoggedIn(true)} unauthorized={rejected} />;

  const openView = (next: View) => { setView(next); setMobileNav(false); setStockNotice(null); setNoteNotice(null); if (next === "inventory") setInventoryFilter("all"); };
  // 從總覽點卡片進來：清掉之前的搜尋字，不然結果會跟卡片上的數字對不上。
  const openInventory = (filter: StockFilter) => { setView("inventory"); setMobileNav(false); setInventoryFilter(filter); setQuery(""); };
  const handleLogout = () => { if (session.configured) session.signOut(); else setDemoLoggedIn(false); };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">茶</span>
          <div><strong>茶香花園民宿</strong><small>內部採購與庫存</small></div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="關閉選單" title="關閉選單"><X size={20} /></button>
        </div>
        <nav>
          {navItems.filter((item) => (item.id !== "report" || canViewPurchaseReport) && (item.id !== "staff" || role === "admin")).map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => openView(item.id)}><Icon size={20} />{item.label}</button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => openView("settings")}><Settings size={19} />系統設定</button>
          <button onClick={handleLogout}><LogOut size={19} />登出</button>
          <p>{session.configured ? "已透過Supabase Auth登入 · 分類與庫存品項所有登入人員共用" : "示範模式 · 資料保存在此瀏覽器"}</p>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="開啟選單" title="開啟選單"><Menu /></button>
          <div className="page-title"><span>茶香花園民宿</span><strong>{view === "settings" ? "系統設定" : navItems.find((n) => n.id === view)?.label}</strong></div>
          <div className="top-actions">
            <NotificationBell lowStock={lowStock} onSelectItem={(item) => { openView("inventory"); setEditingItem(item); setModal("item"); }} />
            <UserMenu
              email={session.configured ? session.email : null}
              displayName={session.configured ? roleState.displayName : null}
              role={role}
              demo={!session.configured}
              onSaved={roleState.setDisplayName}
            />
          </div>
        </header>

        <section className="content">
          {view === "dashboard" && <Dashboard lowStock={lowStock} pending={pending} expiring={expiring} notes={notes.filter((n) => !n.resolvedAt)} status={dashboardStatus} onRetry={retryDashboard} onView={openView} onInventory={openInventory} onPurchase={(name) => openPurchaseModal(name)} canCount={canCountStock} onCount={(item) => { openInventory("expiring"); setCountingItem(item); }} />}
          {view === "inventory" && <InventoryView
            items={inventory}
            filter={inventoryFilter}
            setFilter={setInventoryFilter}
            loading={inventoryState.loading}
            error={inventoryState.error}
            demo={inventoryState.demo}
            categories={filterCategoryNames}
            query={query}
            setQuery={setQuery}
            canManage={canManageItems}
            canReactivateOrDelete={canReactivateOrDeleteItems}
            canCount={canCountStock}
            onAddItem={() => { setEditingItem(null); setModal("item"); }}
            onEditItem={(item) => { setEditingItem(item); setModal("item"); }}
            onToggleActive={(item) => inventoryState.setItemActive(item.id, !item.active)}
            onDeleteItem={(item) => setDeletingItem(item)}
            onCountItem={(item) => setCountingItem(item)}
            onAddMovement={(item) => setMovingItem(item)}
            onPurchase={openPurchaseModal}
            stockNotice={stockNotice}
            onUndoStock={undoStockChange}
            onDismissStock={() => setStockNotice(null)}
            onBulkStocktake={bulkStocktake}
          />}
          {view === "purchases" && <PurchasesView requests={purchases} loading={session.configured && purchasesState.loading} loadError={session.configured ? purchasesState.error : ""} canAdvance={role === "admin" || role === "purchaser" || !session.configured} onAdvance={advancePurchase} onSetPriority={setPurchasePriority} onEdit={editPurchase} onNew={() => openPurchaseModal()} onGoReceipts={() => openView("receipts")} />}
          {view === "receipts" && <ReceiptScanner inventory={activeInventory} categories={activeCategoryNames} receipts={receipts} retentionDays={retentionDays} onConfirm={async (record) => {
            // 新品項建立、庫存數量與異動紀錄都已經在Supabase交易（RPC）內原子性完成，這裡只需要重新整理庫存與進貨單列表。
            await inventoryState.refresh();
            if (session.configured) await receiptsState.refresh(true);
            else setLocalReceipts([record, ...localReceipts]);
          }} />}
          {view === "movement-log" && <MovementLogView inventory={inventory} />}
          {view === "report" && <PurchaseReportView canView={canViewPurchaseReport} canManage={role === "admin"} />}
          {view === "notes" && <NotesView key={notesViewKey} notes={notes} loading={session.configured && notesState.loading} loadError={session.configured ? notesState.error : ""} onRetry={() => { void notesState.refresh(); }} isAdmin={role === "admin" || !session.configured} userId={session.configured ? session.userId : null} notice={noteNotice} onDismissNotice={() => setNoteNotice(null)} onNew={() => { setNoteNotice(null); setModal("note"); }} onEdit={(note) => { setNoteNotice(null); setEditingNote(note); }} onResolve={async (note, resolved) => {
            const error = await resolveNote(note.id, resolved);
            setNoteNotice(error ? { message: `操作失敗：${error}`, error: true } : { message: resolved ? "已標記為已處理，這則留言收進「已處理」分頁。" : "已改回未處理。" });
          }} onDelete={(note) => { setNoteNotice(null); setDeletingNote(note); }} />}
          {view === "staff" && <StaffView canView={role === "admin"} canManage={role === "admin"} currentUserId={session.userId} />}
          {view === "settings" && <SettingsView
            categories={categoryState.categories}
            categoriesLoading={categoryState.loading}
            categoriesError={categoryState.error}
            categoriesDemo={categoryState.demo}
            orphans={categoryState.orphans}
            canManageCategories={role === "admin"}
            onRetryCategories={() => { void categoryState.refresh(); }}
            retentionDays={retentionDays}
            canEditRetention={role === "admin" || role === "purchaser" || !session.configured}
            onAddCategory={categoryState.addCategory}
            onRenameCategory={categoryState.renameCategory}
            onReorderCategories={categoryState.reorderCategories}
            onToggleCategoryActive={categoryState.toggleCategoryActive}
            onDeleteCategory={categoryState.deleteCategory}
            onRetentionChange={changeRetentionDays}
          />}
        </section>
      </main>

      {modal === "purchase" && <PurchaseModal inventory={activeInventory} categories={activeCategoryNames} openRequests={purchases} initialItem={query} onClose={() => setModal(null)} onSave={async (draft) => { const error = await addPurchase(draft); if (error) return error; setModal(null); setQuery(""); }} onCreateItem={inventoryState.createAndReturnItem} />}
      {modal === "item" && <ItemModal
        categories={itemFormCategoryOptions}
        item={editingItem}
        onClose={() => { setModal(null); setEditingItem(null); }}
        onSave={async (payload) => {
          const error = editingItem
            ? await inventoryState.updateItem(editingItem.id, payload)
            : await inventoryState.addItem(payload);
          if (!error) { setModal(null); setEditingItem(null); }
          return error;
        }}
      />}
      {modal === "note" && <NoteModal onClose={() => setModal(null)} onSave={async (draft) => { const error = await addNote(draft); if (error) return error; setModal(null); setNotesViewKey((k) => k + 1); setNoteNotice({ message: "已新增留言，下一班打開就看得到。" }); }} />}
      {editingNote && <NoteModal note={editingNote} onClose={() => setEditingNote(null)} onSave={async (draft) => { const error = await editNote(editingNote.id, draft); if (error) return error; setEditingNote(null); setNoteNotice({ message: "已儲存修改。" }); }} />}
      {deletingItem && <ConfirmDeleteItemModal
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        onConfirm={() => inventoryState.deleteItem(deletingItem.id)}
      />}
      {countingItem && <StockCountModal
        item={countingItem}
        onClose={() => setCountingItem(null)}
        onConfirm={(counts, note) => recordStockChange(countingItem, "已盤點", () => inventoryState.stocktake(countingItem.id, counts, note))}
      />}
      {movingItem && <MovementEntryModal
        item={movingItem}
        onClose={() => setMovingItem(null)}
        onConfirm={(movementType, changeAmount, note, batch) => recordStockChange(movingItem, `已記錄${MOVEMENT_TYPE_LABELS[movementType] ?? "異動"}`, () => inventoryState.countStock(movingItem.id, changeAmount, note, movementType, batch))}
        onGoReceipts={() => { setMovingItem(null); openView("receipts"); }}
      />}
      {deletingNote && <ConfirmDeleteNoteModal
        note={deletingNote}
        onClose={() => setDeletingNote(null)}
        onConfirm={() => deleteNote(deletingNote)}
      />}
    </div>
  );
}

function LoginScreen({ supabaseConfigured, onDemoLogin, unauthorized }: { supabaseConfigured: boolean; onDemoLogin: () => void; unauthorized: boolean }) {
  const [view, setView] = useState<"password" | "reset" | "magiclink">("password");
  const [demoEmail, setDemoEmail] = useState("");

  const redirectMessage = useMemo(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("auth_error");
    if (code === "unauthorized") return "此帳號尚未獲授權或已停用，請聯絡管理員。";
    if (code) return "登入連結已失效或不正確，請重新操作。";
    return null;
  }, []);

  return <main className="login-page">
    <div className="login-art"><div className="mountains" /><div className="login-message"><span>ALISHAN · TEA GARDEN</span><h1>讓每一次補貨，<br />都比缺貨早一步。</h1><p>民宿備品、早餐、晚餐食材與交接事項，一個地方清楚掌握。</p></div></div>
    <div className="login-panel"><div className="login-card">
      <div className="login-logo">茶</div><h2>內部管理系統</h2><p>僅限茶香花園民宿工作人員使用</p>
      {(unauthorized || redirectMessage) && <div className="error-box">{redirectMessage || "此帳號尚未獲授權或已停用，請聯絡管理員。"}</div>}
      {!supabaseConfigured ? <>
        <label>員工Email<input value={demoEmail} onChange={(e) => setDemoEmail(e.target.value)} type="email" /></label>
        <button className="primary-button" onClick={onDemoLogin}>使用示範模式登入<ChevronRight size={18} /></button>
        <div className="login-note">尚未設定Supabase，目前為離線示範模式</div>
      </> : view === "magiclink" ? <MagicLinkCard onBack={() => setView("password")} />
        : view === "reset" ? <ResetRequestCard onBack={() => setView("password")} />
        : <PasswordLoginCard
            onForgot={() => setView("reset")}
            onMagicLink={() => setView("magiclink")}
          />}
    </div></div>
  </main>;
}

function PasswordLoginCard({ onForgot, onMagicLink }: { onForgot: () => void; onMagicLink: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "登入失敗");
      // 刻意用整頁重新導向（不是client router），讓所有session相關的hook用新的cookie重新初始化。
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登入失敗，請稍後再試。");
      setSubmitting(false);
    }
  };

  return <form onSubmit={submit}>
    <label>員工Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@teagarden.local" autoComplete="username" /></label>
    <label>密碼
      <div className="password-field">
        <input required type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button type="button" aria-label={showPassword ? "隱藏密碼" : "顯示密碼"} title={showPassword ? "隱藏密碼" : "顯示密碼"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      </div>
    </label>
    {error && <div className="error-box">{error}</div>}
    <button className="primary-button" disabled={submitting}>{submitting ? "登入中…" : "登入"}<ChevronRight size={18} /></button>
    <div className="login-links">
      <button type="button" className="text-button" onClick={onForgot}>忘記密碼？</button>
    </div>
    <button type="button" className="login-secondary-link" onClick={onMagicLink}>使用Email登入連結</button>
  </form>;
}

function ResetRequestCard({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await response.json() as { message?: string };
      setMessage(data.message || "如果此Email已獲授權，系統將寄送密碼設定或重設信。");
    } catch {
      setMessage("如果此Email已獲授權，系統將寄送密碼設定或重設信。");
    } finally {
      setSubmitting(false);
    }
  };

  return <form onSubmit={submit}>
    <p className="login-note">輸入你的員工Email：如果是第一次登入，會寄送設定密碼的連結；如果已經有密碼，會寄送密碼重設連結。是否已獲授權不會在畫面上顯示。</p>
    <label>員工Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@teagarden.local" /></label>
    {message ? <div className="setting-note">{message}</div> : <button className="primary-button" disabled={submitting}>{submitting ? "寄送中…" : "寄送密碼設定／重設信"}<ChevronRight size={18} /></button>}
    <button type="button" className="text-button" onClick={onBack}>返回登入</button>
  </form>;
}

function MagicLinkCard({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const sendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSending(true);
    setError("");
    try {
      const supabase = createClient();
      // shouldCreateUser: false — 這是公開的備用登入入口，不可以讓任何人靠輸入Email就自動建立新帳號。
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: value,
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (authError) throw authError;
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "寄送登入連結失敗，請稍後再試。");
    } finally {
      setSending(false);
    }
  };

  if (sent) return <div className="setting-note">已寄出登入連結到 {email}，請至信箱點擊連結完成登入。</div>;

  return <form onSubmit={sendMagicLink}>
    <p className="login-note">管理員備用登入方式，僅建議緊急情況使用；一樣需要通過白名單與啟用狀態檢查。</p>
    <label>員工Email<input required value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="you@teagarden.local" /></label>
    {error && <div className="error-box">{error}</div>}
    <button className="primary-button" disabled={sending}>{sending ? "寄送中…" : "寄送登入連結"}<ChevronRight size={18} /></button>
    <button type="button" className="text-button" onClick={onBack}>返回Email密碼登入</button>
  </form>;
}

function NotificationBell({ lowStock, onSelectItem }: { lowStock: InventoryItem[]; onSelectItem: (item: InventoryItem) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  return <div className="notif-wrap" ref={wrapRef}>
    <button className="icon-button" aria-label="通知" title="通知" onClick={() => setOpen((v) => !v)}><Bell size={19} /><i>{lowStock.length}</i></button>
    {open && <div className="notif-dropdown">
      <header>低庫存提醒（{lowStock.length}）</header>
      {lowStock.length === 0 ? <p className="notif-empty">目前沒有低庫存品項。</p> : <div className="notif-list">{lowStock.map((item) => {
        const reason = getLowStockReason(item);
        return <button type="button" key={item.id} onClick={() => onSelectItem(item)}>
          <span><strong>{item.name}</strong><small>{reason ? lowStockReasonLabel(reason) : ""}</small></span>
          <b>{formatNumber(item.quantity)}{item.unit}</b>
        </button>;
      })}</div>}
    </div>}
  </div>;
}

// 有暱稱（staff_profiles.display_name）就顯示暱稱，沒有暱稱才顯示帳號Email；點擊可以打開小面板修改暱稱。
function UserMenu({ email, displayName, role, demo, onSaved }: {
  email: string | null;
  displayName: string | null;
  role: AssignableStaffRole | null;
  demo: boolean;
  onSaved: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(displayName || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) { setOpen(false); setEditing(false); setError(""); }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const shownName = demo ? "管理員 Alan（示範）" : (displayName || email || "員工");
  const avatarLetter = (demo ? "A" : (displayName || email || "?")[0]?.toUpperCase()) || "?";
  const roleLabel = demo ? "管理員（示範）" : (role ? staffRoleLabel(role) : "尚未指派角色");

  const startEditing = () => { setName(displayName || ""); setError(""); setEditing(true); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) { setError("請輸入暱稱。"); return; }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/staff/me", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: value }),
      });
      const data = await response.json() as { error?: string; staff?: { displayName: string } };
      if (!response.ok) throw new Error(data.error || "修改暱稱失敗");
      onSaved(data.staff?.displayName || value);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "修改暱稱失敗，請稍後再試。");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="notif-wrap" ref={wrapRef}>
    <button type="button" className="user-trigger" onClick={() => setOpen((v) => !v)}>
      <div className="user-badge">{avatarLetter}</div>
      <div className="user-copy"><strong>{shownName}</strong><small>{roleLabel}</small></div>
    </button>
    {open && <div className="notif-dropdown profile-dropdown">
      {demo ? <p className="notif-empty">示範模式無法修改暱稱。</p> : editing ? <form onSubmit={submit} className="profile-edit-form">
        <label>暱稱<input required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        {error && <div className="error-box">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "儲存中…" : "儲存"}</button></div>
      </form> : <div className="profile-view">
        <div><small>帳號</small><strong>{email || "—"}</strong></div>
        <button type="button" className="secondary-button" onClick={startEditing}>修改暱稱</button>
      </div>}
    </div>}
  </div>;
}

type SourceStatus = { loading: boolean; failed: boolean };

// 總覽：一打開就知道今天要處理什麼。資料還在載入或載入失敗時，絕不顯示「0」讓人誤以為沒事。
function Dashboard({ lowStock, pending, expiring, notes, status, onRetry, onView, onInventory, onPurchase, canCount, onCount }: {
  lowStock: InventoryItem[];
  pending: PurchaseRequest[];
  expiring: ExpiringBatch[];
  notes: HandoverNote[];
  status: { inventory: SourceStatus; purchases: SourceStatus; notes: SourceStatus };
  onRetry: () => void;
  onView: (v: View) => void;
  onInventory: (filter: StockFilter) => void;
  onPurchase: (itemName?: string) => void;
  canCount: boolean;
  onCount: (item: InventoryItem) => void;
}) {
  const now = new Date();
  const greeting = greetingForHour(getTaipeiHour(now));
  const urgent = pending.filter((r) => r.priority === "急件");
  // 待處理採購：急件排最前面，其他照原本順序。
  const pendingSorted = pending.map((r, i) => ({ r, i })).sort((a, b) => (a.r.priority === "急件" ? 0 : 1) - (b.r.priority === "急件" ? 0 : 1) || a.i - b.i).map(({ r }) => r);
  const ready = (st: SourceStatus) => !st.loading && !st.failed;
  const failedNames = [status.inventory.failed ? "庫存" : "", status.purchases.failed ? "採購需求" : "", status.notes.failed ? "交接留言" : ""].filter(Boolean);
  const anyLoading = status.inventory.loading || status.purchases.loading || status.notes.loading;
  // 標題只用已經載入好的資料；庫存還沒好時不下「都充足」的結論。
  const todo = [
    ready(status.inventory) && lowStock.length > 0 ? `${lowStock.length} 項低庫存` : "",
    ready(status.inventory) && expiring.length > 0 ? `${expiring.length} 批快到期` : "",
    ready(status.purchases) && urgent.length > 0 ? `${urgent.length} 張急件採購` : "",
  ].filter(Boolean);
  const value = (st: SourceStatus, n: number) => ready(st) ? n : null;
  return <>
    <div className="hero-row"><div><p>{formatTaipeiDateLabel(now)}</p>
      <h1>{greeting}，{todo.length > 0 ? <>今天要處理：<em>{todo.join("、")}</em></> : anyLoading ? "正在整理今天的資料…" : failedNames.length > 0 ? "有些資料沒有載入成功" : "今天庫存都充足，沒有急件"}</h1>
    </div><button className="primary-button" onClick={() => onPurchase()}><Plus size={19} />新增採購需求</button></div>
    {failedNames.length > 0 && <div className="error-box dashboard-alert" role="alert"><span>{failedNames.join("、")}資料沒有載入成功，下面的數字可能不正確，請不要依照這些數字判斷要不要補貨。</span><button type="button" className="text-button" onClick={onRetry}><RefreshCw size={14} />重新整理</button></div>}
    <div className="stat-grid">
      <Stat icon={AlertTriangle} label="低庫存" hint="少於安全庫存或預估用量" value={value(status.inventory, lowStock.length)} tone="red" onClick={() => onInventory("low")} />
      <Stat icon={ShoppingCart} label="待處理採購" hint={ready(status.purchases) && urgent.length > 0 ? `其中 ${urgent.length} 張急件` : "還沒入庫的需求"} urgentHint={ready(status.purchases) && urgent.length > 0} value={value(status.purchases, pending.length)} tone="sage" onClick={() => onView("purchases")} />
      <Stat icon={Clock3} label="快到期" hint={`已過期或${EXPIRY_WINDOW_LABEL}內到期`} value={value(status.inventory, expiring.length)} tone="gold" onClick={() => onInventory("expiring")} />
      <Stat icon={MessageSquareText} label="交接留言" hint="還沒處理的留言" value={value(status.notes, notes.length)} tone="blue" onClick={() => onView("notes")} />
    </div>
    <div className="dashboard-grid">
      <Panel title="低庫存品項" icon={Box} more={ready(status.inventory) ? lowStock.length - 5 : 0} moreLabel="項低庫存" onMore={() => onInventory("low")}>
        {!ready(status.inventory) ? <PanelPlaceholder loading={status.inventory.loading} /> : lowStock.length === 0 ? <p className="panel-empty">目前沒有低庫存的品項，庫存都在安全數量以上。</p>
          : <div className="compact-list">{lowStock.slice(0, 5).map((item) => <div key={item.id}><span className="item-avatar">{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><small>{item.category} · 安全庫存 {formatNumber(item.safetyStock)}{item.unit}</small></div><b className="danger-text">{formatNumber(item.quantity)}{item.unit}</b><button type="button" className="row-text-button dashboard-row-action" onClick={() => onPurchase(item.name)}><ShoppingCart size={14} />採購</button></div>)}</div>}
      </Panel>
      <Panel title="待處理採購" icon={ShoppingCart} more={ready(status.purchases) ? pending.length - 5 : 0} moreLabel="張待處理採購" onMore={() => onView("purchases")}>
        {!ready(status.purchases) ? <PanelPlaceholder loading={status.purchases.loading} /> : pending.length === 0 ? <p className="panel-empty">沒有待處理的採購需求。</p>
          : <div className="compact-list">{pendingSorted.slice(0, 5).map((r) => <button type="button" key={r.id} className="compact-row-button" onClick={() => onView("purchases")}><div><strong>{r.itemName}</strong><small>{r.requester} · {r.requestedAt.slice(5, 10)}</small></div><b>{r.quantity}{r.unit}</b><span className="pill-group">{r.priority === "急件" && <Pill tone="red">急件</Pill>}<Status status={r.status} /></span></button>)}</div>}
      </Panel>
      <Panel title="快到期食材" icon={Clock3} more={ready(status.inventory) ? expiring.length - 6 : 0} moreLabel="批快到期" onMore={() => onInventory("expiring")}>
        {!ready(status.inventory) ? <PanelPlaceholder loading={status.inventory.loading} /> : <div className="expiry-list">{expiring.length === 0 ? <p className="panel-empty">{EXPIRY_WINDOW_LABEL}內沒有到期的批次。</p> : expiring.slice(0, 6).map(({ item, batch, expiryDate, daysLeft }) => <div key={batch.id}><div><strong>{item.name}</strong><small>這批 {formatNumber(batch.quantity)}{item.unit} · {expiryDate} 到期</small></div><span className="pill-group"><Pill tone={daysLeft < 0 ? "red" : "gold"}>{expiryLabel(daysLeft)}</Pill><button type="button" className="row-text-button dashboard-row-action" disabled={!canCount} onClick={() => onCount(item)} title={canCount ? "數完這項的實際數量，改成正確的數字" : "你的帳號沒有盤點權限"}><ClipboardCheck size={14} />盤點</button></span></div>)}</div>}
      </Panel>
      <Panel title="最新交接留言" icon={MessageSquareText} more={ready(status.notes) ? notes.length - 3 : 0} moreLabel="則留言" onMore={() => onView("notes")}>
        {!ready(status.notes) ? <PanelPlaceholder loading={status.notes.loading} /> : notes.length === 0 ? <p className="panel-empty">沒有需要接手的留言。</p>
          : <div className="note-list">{notes.slice(0, 3).map((note) => <div key={note.id}><span className={note.important ? "note-dot important" : "note-dot"} /><div><strong>{note.content}</strong><small>{note.author} · {note.createdAt}</small></div></div>)}</div>}
      </Panel>
    </div>
  </>;
}

// 資料還沒好時的區塊內容：載入中或「沒有載入成功」，不顯示空白或假的「沒有」。
function PanelPlaceholder({ loading }: { loading: boolean }) {
  return <p className="panel-empty">{loading ? "載入中…" : "資料沒有載入成功，請按上方「重新整理」。"}</p>;
}

function Stat({ icon: Icon, label, hint, urgentHint, value, tone, onClick }: { icon: typeof Box; label: string; hint?: string; urgentHint?: boolean; value: number | null; tone: string; onClick: () => void }) {
  return <button className={`stat-card stat-${tone}`} onClick={onClick}><span><Icon size={24} /></span><div><small>{label}</small><strong>{value === null ? "—" : value}</strong>{hint && <em className={urgentHint ? "stat-hint urgent" : "stat-hint"}>{hint}</em>}</div><ChevronRight size={20} /></button>;
}

// 面板標題不再放「查看」連結（上方統計卡已是入口）；只有清單被截斷時，在底部提示還有幾筆並可點進去。
function Panel({ title, icon: Icon, more = 0, moreLabel = "", onMore, children }: { title: string; icon: typeof Box; more?: number; moreLabel?: string; onMore?: () => void; children: React.ReactNode }) {
  return <article className="panel"><header><h2><Icon size={21} />{title}</h2></header>{children}{more > 0 && onMore && <button type="button" className="panel-more" onClick={onMore}>還有 {more} {moreLabel}，查看全部<ChevronRight size={15} /></button>}</article>;
}

function PageHeader({ title, subtitle, button, onClick }: { title: string; subtitle: string; button?: string; onClick?: () => void }) {
  return <div className="section-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{button && <button className="primary-button" onClick={onClick}><Plus size={18} />{button}</button>}</div>;
}

type StockFilter = "all" | "low" | "expiring";
const STOCK_FILTERS: Array<{ id: StockFilter; label: string }> = [{ id: "all", label: "全部" }, { id: "low", label: "低庫存" }, { id: "expiring", label: "快到期" }];

// 盤點／異動存完後的提示：before／after 是存之前與存之後的品項，用來顯示改了多少、以及復原。
type StockChange = { before: InventoryItem; after: InventoryItem };
type StockNotice = { title: string; changes: StockChange[]; error?: string; canRetry?: boolean; undone?: boolean; stale?: boolean };

function describeStockChange({ before, after }: StockChange, undone = false): string {
  const from = undone ? after.quantity : before.quantity;
  const to = undone ? before.quantity : after.quantity;
  return `「${after.name}」${formatNumber(from)} → ${formatNumber(to)} ${after.unit}（${formatSignedNumber(roundQuantity(to - from))}）`;
}

function StockChangeNotice({ notice, canUndo, onUndo, onDismiss }: { notice: StockNotice; canUndo: boolean; onUndo: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  const shown = notice.changes.slice(0, 3).map((c) => describeStockChange(c, notice.undone)).join("、");
  const more = notice.changes.length > 3 ? `，還有 ${notice.changes.length - 3} 項` : "";
  const text = notice.error
    ? `復原失敗：${notice.error}`
    : notice.stale ? notice.title
    : `${notice.title}${notice.changes.length > 1 ? "：" : " "}${shown}${more}`;
  const undo = async () => { setBusy(true); try { await onUndo(); } finally { setBusy(false); } };
  const showUndo = canUndo && !notice.undone && !notice.stale && (!notice.error || notice.canRetry);
  return <div className={notice.error || notice.stale ? "error-box inventory-notice" : "inventory-notice"} role={notice.error || notice.stale ? "alert" : "status"}>
    <span>{text}</span>
    {showUndo && <button type="button" className="text-button" onClick={undo} disabled={busy}><Undo2 size={14} />{busy ? "復原中…" : notice.error ? "再試一次" : "復原"}</button>}
    <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={onDismiss}><X size={14} /></button>
  </div>;
}

function InventoryView({ items, filter, setFilter, loading, error, demo, categories, query, setQuery, canManage, canReactivateOrDelete, canCount, onAddItem, onEditItem, onToggleActive, onDeleteItem, onCountItem, onAddMovement, onPurchase, stockNotice, onUndoStock, onDismissStock, onBulkStocktake }: {
  items: InventoryItem[];
  filter: StockFilter;
  setFilter: (f: StockFilter) => void;
  loading: boolean;
  error: string;
  demo: boolean;
  categories: string[];
  query: string;
  setQuery: (q: string) => void;
  canManage: boolean;
  canReactivateOrDelete: boolean;
  canCount: boolean;
  onAddItem: () => void;
  onEditItem: (item: InventoryItem) => void;
  onToggleActive: (item: InventoryItem) => Promise<string | void>;
  onDeleteItem: (item: InventoryItem) => void;
  onCountItem: (item: InventoryItem) => void;
  onAddMovement: (item: InventoryItem) => void;
  onPurchase: (name: string) => void;
  stockNotice: StockNotice | null;
  onUndoStock: () => Promise<void>;
  onDismissStock: () => void;
  onBulkStocktake: (entries: Array<{ item: InventoryItem; counts: StocktakeCount[] }>, note?: string) => Promise<Record<string, string>>;
}) {
  const [category, setCategory] = useState("全部");
  const [bulk, setBulk] = useState(false);
  // 停用／啟用後的提示：停用的品項會從清單消失（預設不顯示停用品項），要讓員工知道發生什麼事，也可以馬上復原。
  const [toggleNotice, setToggleNotice] = useState<{ item: InventoryItem; nowActive: boolean; error?: string; undoFailed?: boolean } | null>(null);
  // 只採用最後一次操作的結果：連續停用／復原時，晚回來的舊結果不會蓋掉新的提示。
  const toggleSeq = useRef(0);
  const toggleActive = async (item: InventoryItem) => {
    const seq = ++toggleSeq.current;
    const err = await onToggleActive(item);
    if (seq !== toggleSeq.current) return;
    setToggleNotice(err ? { item, nowActive: item.active, error: err } : { item, nowActive: !item.active });
  };
  const undoToggle = async () => {
    if (!toggleNotice) return;
    const { item, nowActive } = toggleNotice;
    const seq = ++toggleSeq.current;
    const err = await onToggleActive({ ...item, active: nowActive });
    if (seq !== toggleSeq.current) return;
    setToggleNotice(err ? { item, nowActive, error: err, undoFailed: true } : null);
  };
  // 停用之後要「復原」＝重新啟用，需要有啟用權限；沒有權限就不顯示復原按鈕。復原失敗時可以再試一次。
  const canUndo = toggleNotice && (!toggleNotice.error || toggleNotice.undoFailed) && (toggleNotice.nowActive ? canManage : canReactivateOrDelete);
  const [showInactive, setShowInactive] = useState(false);
  const todayKey = taipeiDateKey();
  const visible = showInactive ? items : items.filter((item) => item.active);
  // 搜尋：品名或供應商，不分大小寫、前後空白不算。
  const q = query.trim().toLowerCase();
  const searched = visible.filter((item) => (category === "全部" || item.category === category) && (!q || `${item.name} ${item.supplier ?? ""}`.toLowerCase().includes(q)));
  const expiringIds = new Set(getExpiringBatches(searched, todayKey).map((entry) => entry.item.id));
  const isLow = (item: InventoryItem) => item.active && Boolean(getLowStockReason(item));
  const counts = { all: searched.length, low: searched.filter(isLow).length, expiring: searched.filter((item) => expiringIds.has(item.id)).length };
  // 排序：低庫存在最上面，再來是快到期，其他照原本順序。
  const rank = (item: InventoryItem) => isLow(item) ? 0 : expiringIds.has(item.id) ? 1 : 2;
  const filtered = searched
    .filter((item) => filter === "all" || (filter === "low" ? isLow(item) : expiringIds.has(item.id)))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
  const narrowing = [q ? `搜尋「${query.trim()}」` : "", category !== "全部" ? `分類「${category}」` : "", filter !== "all" ? `只看「${STOCK_FILTERS.find((f) => f.id === filter)?.label}」` : ""].filter(Boolean);
  const clearFilters = () => { setQuery(""); setCategory("全部"); setFilter("all"); };
  const emptyTitle = items.length === 0 ? "還沒有任何庫存品項"
    : filter === "low" && narrowing.length === 1 ? "目前沒有低庫存的品項"
    : filter === "expiring" && narrowing.length === 1 ? `${EXPIRY_WINDOW_LABEL}內沒有快到期的批次`
    : "找不到符合的品項";
  const bulkItems = filtered.filter((item) => item.active);
  return <><div className="section-header"><div><h1>{bulk ? "整批盤點" : "庫存管理"}</h1><p>{bulk ? "數完實際數量直接填進來，跟系統一樣的可以留空。可以用上面的分類、搜尋縮小範圍，一次盤一區。" : "掌握各區備品與食材數量，低於安全庫存或預估用量不足時立即提醒。"}</p></div>
      {!bulk && <div className="header-actions">
        <button type="button" className="secondary-button" onClick={() => { setBulk(true); onDismissStock(); }} disabled={!canCount || demo} title={canCount ? "一次輸入多個品項的實際數量" : "你的帳號沒有盤點權限"}><ClipboardCheck size={17} />整批盤點</button>
        <button className="primary-button" onClick={onAddItem} disabled={!canManage}><Plus size={18} />新增品項</button>
      </div>}
    </div>
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示唯讀示範庫存，無法新增／編輯／停用／刪除／盤點。</span></div>}
    {error && <div className="error-box">{error}</div>}
    {toggleNotice && <div className={toggleNotice.error ? "error-box inventory-notice" : "inventory-notice"} role={toggleNotice.error ? "alert" : "status"}>
      <span>{toggleNotice.error ? `「${toggleNotice.item.name}」${toggleNotice.undoFailed ? "復原" : toggleNotice.item.active ? "停用" : "啟用"}失敗：${toggleNotice.error}` : toggleNotice.nowActive ? `已重新啟用「${toggleNotice.item.name}」` : `已停用「${toggleNotice.item.name}」，它不會再出現在清單和低庫存提醒裡。勾選「顯示停用品項」可以看到它。`}</span>
      {canUndo && <button type="button" className="text-button" onClick={undoToggle}><Undo2 size={14} />{toggleNotice.undoFailed ? "再試一次" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setToggleNotice(null)}><X size={14} /></button>
    </div>}
    {stockNotice && <StockChangeNotice notice={stockNotice} canUndo={canCount} onUndo={onUndoStock} onDismiss={onDismissStock} />}
    <div className="toolbar">
      <div className="stock-filter" role="group" aria-label="篩選庫存">{STOCK_FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>{f.label}<span>{counts[f.id]}</span></button>)}</div>
      <div className="search-box"><Search size={18} /><input placeholder="搜尋品項或供應商" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜尋品項或供應商" /></div>
      <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類"><option>全部</option>{categories.map((name) => <option key={name}>{name}</option>)}</select>
      {!bulk && <label className="check-label inline-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />顯示停用品項</label>}
    </div>
    {bulk ? <BulkStocktake items={bulkItems} allItems={items.filter((item) => item.active)} narrowing={narrowing} onClearFilters={clearFilters} onSubmit={onBulkStocktake} onExit={() => setBulk(false)} />
    : loading ? <p>載入庫存中…</p> : <div className="table-card"><table className="inventory-table"><thead><tr><th>品項</th><th>分類</th><th>目前庫存</th><th>預估使用</th><th>有效期限</th><th>狀態</th><th>操作</th></tr></thead><tbody>
      {filtered.length === 0 && <tr className="inventory-empty"><td colSpan={7}>
        <strong>{emptyTitle}</strong>
        {items.length === 0
          ? (canManage && <button type="button" className="secondary-button" onClick={onAddItem}><Plus size={15} />新增第一個品項</button>)
          : narrowing.length > 0 && <span>目前條件：{narrowing.join("、")}<button type="button" className="text-button" onClick={clearFilters}>清除篩選，顯示全部</button></span>}
      </td></tr>}
      {filtered.map((item) => {
        const reason = getLowStockReason(item);
        const remaining = estimatedRemainingLabel(item);
        return <tr key={item.id} className={item.active ? "" : "inventory-row-inactive"}>
          <td data-label="品項"><strong>{item.name}</strong><small>{item.supplier || "未設定供應商"}</small></td>
          <td data-label="分類">{item.category}</td>
          <td data-label="目前庫存"><b className={reason ? "danger-text" : ""}>{formatNumber(item.quantity)} {item.unit}</b><small>安全庫存 {formatNumber(item.safetyStock)} {item.unit}</small></td>
          <td data-label="預估使用">{item.usageForecastEnabled && item.estimatedUsage && item.usagePeriod ? <><strong>{periodFrequencyLabel(item.usagePeriod)}{formatNumber(item.estimatedUsage)}{item.unit}</strong><small>{remaining}</small></> : <small>未啟用</small>}</td>
          <td data-label="有效期限"><BatchExpiryList item={item} todayKey={todayKey} /></td>
          <td data-label="狀態">{!item.active ? <Pill tone="red">已停用</Pill> : reason ? <div className="status-cell"><Pill tone="red">低庫存</Pill><small className="danger-text">{lowStockReasonLabel(reason)}</small></div> : expiringIds.has(item.id) ? <Pill tone="gold">快到期</Pill> : <Pill>充足</Pill>}</td>
          <td data-label="操作"><div className="row-actions">
            {item.active && <button type="button" className="row-text-button" onClick={() => onPurchase(item.name)}><ShoppingCart size={14} />採購</button>}
            <button type="button" className="row-text-button" disabled={!canCount} onClick={() => onCountItem(item)} title={canCount ? "數完實際數量，改成正確的數字" : "你的帳號沒有盤點權限"}><ClipboardCheck size={14} />盤點</button>
            <button type="button" className="row-text-button" disabled={!canCount} onClick={() => onAddMovement(item)} title={canCount ? "記一筆用掉、補房、損壞或報廢" : "你的帳號沒有新增異動的權限"}><ClipboardList size={14} />異動</button>
            <RowMenu item={item} canManage={canManage} canReactivateOrDelete={canReactivateOrDelete} onEdit={() => onEditItem(item)} onToggle={() => toggleActive(item)} onDelete={() => onDeleteItem(item)} />
          </div></td>
        </tr>;
      })}
    </tbody></table></div>}
  </>;
}

// 「⋯」選單（庫存每列、採購卡片共用）：用畫面座標定位才不會被捲動框切掉，下方空間不夠時往上開；
// 點外面、按Esc、捲動頁面都會關掉；鍵盤上下鍵移動，Esc後游標回到「⋯」按鈕。沒權限的項目會寫出原因。
type ActionMenuItem = { label: string; icon: typeof Box; onClick: () => void; disabled?: boolean; note?: string; danger?: boolean; hidden?: boolean };
function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
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
      const menuH = 12 + shown.length * 38, menuW = 196;
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

function RowMenu({ item, canManage, canReactivateOrDelete, onEdit, onToggle, onDelete }: { item: InventoryItem; canManage: boolean; canReactivateOrDelete: boolean; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const toggleAllowed = item.active ? canManage : canReactivateOrDelete;
  return <ActionMenu label={`${item.name}的更多操作`} items={[
    { label: "編輯品項", icon: Pencil, onClick: onEdit, disabled: !canManage, note: canManage ? undefined : "沒有權限" },
    { label: item.active ? "停用品項" : "重新啟用", icon: Power, onClick: onToggle, disabled: !toggleAllowed, note: toggleAllowed ? undefined : "沒有權限" },
    { label: "刪除品項", icon: Trash2, onClick: onDelete, disabled: !canReactivateOrDelete, note: canReactivateOrDelete ? undefined : "沒有權限", danger: true },
  ]} />;
}

// 有效期限欄：列出每一批的到期日與數量（先到期的在上面），已過期或EXPIRY_WARNING_DAYS天內到期的標紅。
// 只有一批而且未標日期時顯示「—」，跟以前沒填期限的樣子一樣。
function BatchExpiryList({ item, todayKey }: { item: InventoryItem; todayKey: string }) {
  if (item.batches.length === 0 || (item.batches.length === 1 && item.batches[0].expiryDate === null)) return <>—</>;
  const soonKeys = new Set(getExpiringBatches([item], todayKey).map((entry) => entry.batch.id));
  return <div className="batch-expiry-list">{item.batches.map((batch) => <small key={batch.id} className={soonKeys.has(batch.id) ? "danger-text" : ""}>{batch.expiryDate ?? "未標日期"} · {formatNumber(batch.quantity)}{item.unit}</small>)}</div>;
}

// 整批盤點：列出目前篩選到的品項，每一批一個輸入框（沒有庫存的品項一個框）。留空＝跟系統一樣。
// 填的內容以「品項:批次」記住，切換分類、搜尋時不會不見；按 Enter 跳到下一格。
const NEW_BATCH_KEY = "new";
function BulkStocktake({ items, allItems, narrowing, onClearFilters, onSubmit, onExit }: {
  items: InventoryItem[];
  allItems: InventoryItem[];
  narrowing: string[];
  onClearFilters: () => void;
  onSubmit: (entries: Array<{ item: InventoryItem; counts: StocktakeCount[] }>, note?: string) => Promise<Record<string, string>>;
  onExit: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const key = (itemId: string, batchId: string) => `${itemId}:${batchId}`;
  const parse = (raw: string | undefined): number | null | "invalid" => {
    if (raw === undefined || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? roundQuantity(n) : "invalid";
  };
  // 每個品項算出要送的盤點內容、盤點後總數、有沒有填錯。
  const plan = (item: InventoryItem) => {
    let invalid = false;
    let total = 0;
    const counts: StocktakeCount[] = [];
    if (item.batches.length === 0) {
      const v = parse(values[key(item.id, NEW_BATCH_KEY)]);
      if (v === "invalid") invalid = true;
      else if (v !== null && v > 0) { counts.push({ actual: v }); total = v; }
    } else {
      for (const b of item.batches) {
        const v = parse(values[key(item.id, b.id)]);
        if (v === "invalid") { invalid = true; total += b.quantity; continue; }
        if (v !== null && v !== b.quantity) counts.push({ batchId: b.id, actual: v });
        total += v ?? b.quantity;
      }
    }
    return { counts, total: roundQuantity(total), invalid };
  };
  // 用全部啟用中的品項來算：先填了客房、再切到廚房填，送出時兩邊都會送，不會因為篩選掉就漏掉。
  const plans = new Map(allItems.map((item) => [item.id, plan(item)]));
  const changed = allItems.filter((item) => (plans.get(item.id)?.counts.length ?? 0) > 0);
  const invalidCount = allItems.filter((item) => plans.get(item.id)?.invalid).length;
  const shownIds = new Set(items.map((item) => item.id));
  const hiddenChanged = changed.filter((item) => !shownIds.has(item.id)).length;
  const touched = Object.values(values).some((v) => v.trim() !== "");

  const setValue = (k: string, v: string) => { setValues((prev) => ({ ...prev, [k]: v })); setConfirmExit(false); };
  const focusNext = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>("input[data-bulk]") ?? []);
    const next = inputs[inputs.indexOf(e.currentTarget) + 1];
    if (next) { next.focus(); next.select(); }
  };
  const submit = async () => {
    if (changed.length === 0 || invalidCount > 0) return;
    setSubmitting(true);
    const result = await onSubmit(changed.map((item) => ({ item, counts: plans.get(item.id)!.counts })), note.trim() || undefined);
    setSubmitting(false);
    setFailed(result);
    // 成功的品項清掉填的數字（數字已經變成新的系統數量）；失敗的留著讓員工改。
    setValues((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => result[k.split(":")[0]])));
    if (Object.keys(result).length === 0) { setNote(""); onExit(); }
  };
  const exit = () => { if (touched && !confirmExit) { setConfirmExit(true); return; } onExit(); };

  return <div className="bulk-count">
    {items.length === 0 ? <div className="table-card bulk-empty"><strong>沒有符合的品項</strong>{narrowing.length > 0 && <span>目前條件：{narrowing.join("、")}<button type="button" className="text-button" onClick={onClearFilters}>清除篩選，顯示全部</button></span>}</div>
    : <div className="table-card bulk-list" ref={listRef}>
      {items.map((item) => {
        const p = plans.get(item.id) ?? plan(item);
        const large = !p.invalid && p.counts.length > 0 && isLargeStockDiff(item.quantity, p.total);
        const diff = roundQuantity(p.total - item.quantity);
        const rows = item.batches.length === 0 ? [{ id: NEW_BATCH_KEY, label: "目前沒有庫存", system: 0 }] : item.batches.map((b) => ({ id: b.id, label: b.expiryDate ? `${b.expiryDate} 到期` : item.batches.length > 1 ? "未標日期" : "目前庫存", system: b.quantity }));
        return <section key={item.id} className={`bulk-item${p.counts.length > 0 ? " bulk-item-changed" : ""}`}>
          <header><strong>{item.name}</strong><small>{item.category}</small>
            {p.counts.length > 0 && <b className={diff < 0 ? "danger-text" : diff > 0 ? "positive-text" : ""}>{formatNumber(item.quantity)} → {formatNumber(p.total)} {item.unit}（{formatSignedNumber(diff)}）</b>}
          </header>
          {rows.map((row) => { const v = values[key(item.id, row.id)] ?? ""; const bad = parse(v) === "invalid"; return <label key={row.id} className="bulk-batch">
            <span>{row.label}<small>系統 {formatNumber(row.system)} {item.unit}</small></span>
            <input data-bulk type="number" inputMode="decimal" min="0" step="0.5" placeholder={formatNumber(row.system)} value={v} disabled={submitting} aria-invalid={bad} aria-label={`${item.name} ${row.label} 實際數量（${item.unit}）`} onChange={(e) => setValue(key(item.id, row.id), e.target.value)} onKeyDown={focusNext} />
            <em>{item.unit}</em>
          </label>; })}
          {p.invalid && <small className="danger-text">數量要是 0 以上的數字（最小 0.5）。</small>}
          {large && <small className="bulk-warn">跟系統差很多，請再數一次，或確認單位是不是「{item.unit}」。</small>}
          {failed[item.id] && <small className="danger-text" role="alert">沒有存到：{failed[item.id]}</small>}
        </section>;
      })}
    </div>}
    <footer className="bulk-footer">
      <label className="bulk-note">備註（可不填）<input value={note} disabled={submitting} onChange={(e) => setNote(e.target.value)} placeholder="例如：11 月月底盤點" /></label>
      <div className="bulk-footer-actions">
        <span className="bulk-summary">{invalidCount > 0 ? <span className="danger-text">{invalidCount} 項數量填錯</span> : changed.length > 0 ? `${changed.length} 項跟系統不一樣${hiddenChanged > 0 ? `（${hiddenChanged} 項不在目前清單）` : ""}` : "還沒有跟系統不一樣的數量"}</span>
        <button type="button" className={confirmExit ? "secondary-button danger-outline" : "secondary-button"} onClick={exit} disabled={submitting}>{confirmExit ? "確定放棄填的數字？" : "取消"}</button>
        <button type="button" className="primary-button" onClick={submit} disabled={submitting || changed.length === 0 || invalidCount > 0}>{submitting ? "儲存中…" : changed.length > 0 ? `送出盤點（${changed.length} 項）` : "送出盤點"}</button>
      </div>
    </footer>
  </div>;
}

// 看板上每一欄的「推進」按鈕寫清楚會變成什麼；已到貨的下一步是去建立進貨單（實際入庫）。
const NEXT_ACTION_LABEL: Partial<Record<PurchaseStatus, string>> = { "待確認": "標記已訂購", "已訂購": "標記已到貨" };

function PurchasesView({ requests, loading, loadError, canAdvance, onAdvance, onSetPriority, onEdit, onNew, onGoReceipts }: {
  requests: PurchaseRequest[];
  loading: boolean;
  loadError: string;
  canAdvance: boolean;
  onAdvance: (id: string, status: PurchaseStatus) => Promise<string | void>;
  onSetPriority: (id: string, priority: PurchaseRequest["priority"]) => Promise<string | void>;
  onEdit: (id: string, patch: { quantity: number; note: string }) => Promise<string | void>;
  onNew: () => void;
  onGoReceipts: () => void;
}) {
  // 每張卡片各自記錄「處理中」，同時操作好幾張也不會互相干擾。
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const setBusy = (id: string, on: boolean) => setBusyIds((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  const isBusy = (id: string) => busyIds.has(id);
  // 錯誤顯示在出錯的那張卡片上，不放在頁面最上方（捲下去時看不到）。
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);
  // 狀態改變後的提示：可以馬上復原（改回原本的狀態）。復原失敗的錯誤顯示在提示條上（卡片可能已經不在看板上）。
  // items：這次被移動的需求（整欄一次標記時會有好幾筆）；failed：整欄標記時沒成功的筆數；error：復原失敗的原因。
  const [moved, setMoved] = useState<{ items: Array<{ request: PurchaseRequest; from: PurchaseStatus }>; to: PurchaseStatus; failed?: number; error?: string } | null>(null);
  const [showPaused, setShowPaused] = useState(false);
  // 修改數量／備註（只有「待確認」可以改）：直接在卡片上展開小表單。
  const [editing, setEditing] = useState<{ id: string; quantity: number; note: string; saving: boolean; error?: string } | null>(null);
  const moveSeq = useRef(0);
  // 整欄標記進行中時，其他推進按鈕先停用，避免兩批同時跑、復原紀錄互相蓋掉。
  const [bulkRunning, setBulkRunning] = useState(false);

  // 「採購需求」只是提醒／追蹤用的看板，不會直接增加庫存。實際入庫一律要另外到「新增進貨單」建立進貨單，
  // 才會真正呼叫record_stock_movement增加庫存。
  const moveTo = async (request: PurchaseRequest, to: PurchaseStatus) => {
    if (request.status === to || isBusy(request.id) || bulkRunning) return;
    const seq = ++moveSeq.current;
    setBusy(request.id, true);
    if (cardError?.id === request.id) setCardError(null);
    const error = await onAdvance(request.id, to);
    setBusy(request.id, false);
    if (error) { setCardError({ id: request.id, message: error }); return; }
    // 只有最後一次成功的操作會顯示在提示條（才不會被晚回來的舊結果蓋掉）。
    if (seq === moveSeq.current) setMoved({ items: [{ request, from: request.status }], to });
  };
  // 整欄一次標記（例如同一家供應商一起訂）：一筆一筆送，成功的可以一起復原，失敗的會寫出筆數。
  const moveAll = async (list: PurchaseRequest[], to: PurchaseStatus) => {
    const targets = list.filter((r) => r.status !== to && !isBusy(r.id));
    if (targets.length === 0 || bulkRunning) return;
    const seq = ++moveSeq.current;
    setBulkRunning(true);
    targets.forEach((r) => setBusy(r.id, true));
    const done: Array<{ request: PurchaseRequest; from: PurchaseStatus }> = [];
    let failed = 0, lastError = "";
    for (const r of targets) {
      const error = await onAdvance(r.id, to);
      setBusy(r.id, false);
      if (error) { failed++; lastError = error; } else done.push({ request: r, from: r.status });
    }
    setBulkRunning(false);
    if (seq === moveSeq.current) setMoved({ items: done, to, failed: failed || undefined, error: failed ? lastError : undefined });
  };
  const undoMove = async () => {
    if (!moved || moved.items.some((it) => isBusy(it.request.id))) return;
    const current = moved;
    current.items.forEach((it) => setBusy(it.request.id, true));
    const left: typeof current.items = [];
    let lastError = "";
    for (const it of current.items) {
      const error = await onAdvance(it.request.id, it.from);
      setBusy(it.request.id, false);
      if (error) { left.push(it); lastError = error; }
    }
    // 全部復原成功就關掉提示；有失敗的留在提示條上，可以再試一次。
    setMoved((m) => m === current ? (left.length > 0 ? { items: left, to: current.to, error: `復原失敗：${lastError}` } : null) : m);
  };
  const saveEdit = async () => {
    if (!editing) return;
    const quantity = roundQuantity(Number(editing.quantity));
    if (!(quantity > 0)) { setEditing({ ...editing, error: "採購數量必須大於0。" }); return; }
    setEditing({ ...editing, saving: true, error: undefined });
    const error = await onEdit(editing.id, { quantity, note: editing.note });
    setEditing((e) => e && e.id === editing.id ? (error ? { ...e, saving: false, error } : null) : e);
  };

  // 只有「待確認」階段可以改急迫程度；訂購後再改沒有意義。
  const changePriority = async (request: PurchaseRequest, priority: PurchaseRequest["priority"]) => {
    if (request.priority === priority || isBusy(request.id)) return;
    setBusy(request.id, true);
    if (cardError?.id === request.id) setCardError(null);
    const error = await onSetPriority(request.id, priority);
    setBusy(request.id, false);
    if (error) setCardError({ id: request.id, message: error });
  };

  // 每一欄急件排最上面，其他照原本順序。
  const inColumn = (status: PurchaseStatus) => requests
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.status === status)
    .sort((a, b) => (a.r.priority === "急件" ? 0 : 1) - (b.r.priority === "急件" ? 0 : 1) || a.index - b.index)
    .map(({ r }) => r);
  const paused = requests.filter((r) => r.status === "暫緩");
  const movedName = moved ? (moved.items.length === 1 ? `「${moved.items[0].request.itemName}」` : `${moved.items.length} 筆需求`) : "";
  const movedText = !moved ? "" : moved.failed && moved.items.length === 0 ? `${moved.failed} 筆都沒有成功：${moved.error}` : moved.error && !moved.failed ? moved.error
    : (moved.to === "暫緩" ? `已暫緩${movedName}，會收到下方「暫緩中」。` : moved.to === "已入庫" ? `已把${movedName}標記為已處理。` : `已把${movedName}移到「${moved.to}」。`)
      + (moved.failed ? `另外有 ${moved.failed} 筆沒有成功：${moved.error}` : "");

  const card = (r: PurchaseRequest, status: PurchaseStatus) => {
    const index = statusSteps.indexOf(status);
    const prev = index > 0 ? statusSteps[index - 1] : null;
    return <article key={r.id} className={`purchase-card${r.priority === "急件" ? " purchase-card-urgent" : ""}`}>
      <div className="purchase-card-head">
        <div><strong>{r.itemName}</strong><span className="purchase-card-qty">{r.quantity} {r.unit}</span>{r.priority === "急件" && <Pill tone="red">急件</Pill>}</div>
        {canAdvance && <ActionMenu label={`${r.itemName}採購需求的更多操作`} items={[
          { label: "修改數量／備註", icon: Pencil, onClick: () => setEditing({ id: r.id, quantity: r.quantity, note: r.note ?? "", saving: false }), hidden: status !== "待確認", disabled: isBusy(r.id) },
          { label: `退回「${prev ?? ""}」`, icon: Undo2, onClick: () => { if (prev) moveTo(r, prev); }, hidden: !prev, disabled: isBusy(r.id) },
          { label: "標記已處理（已入庫）", icon: Check, onClick: () => moveTo(r, "已入庫"), hidden: status !== "已到貨", disabled: isBusy(r.id) },
          { label: "暫緩這筆需求", icon: PauseCircle, onClick: () => moveTo(r, "暫緩"), disabled: isBusy(r.id) },
        ]} />}
      </div>
      {editing?.id === r.id ? <form className="purchase-edit" onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
        <label>採購數量（{r.unit}）<input type="number" min="0.5" step="0.5" value={editing.quantity} onChange={(e) => setEditing({ ...editing, quantity: Number(e.target.value) })} autoFocus /></label>
        <label>原因或備註<textarea value={editing.note} maxLength={500} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></label>
        {editing.error && <div className="error-box purchase-card-error" role="alert">{editing.error}</div>}
        <div className="purchase-edit-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)} disabled={editing.saving}>取消</button><button type="submit" className="primary-button" disabled={editing.saving}>{editing.saving ? "儲存中…" : "儲存"}</button></div>
      </form> : r.note && <p>{r.note}</p>}
      <small>{r.requester} · {r.requestedAt}</small>
      {status === "待確認" && canAdvance && editing?.id !== r.id && <div className="priority-toggle" role="group" aria-label="急迫程度">{(["一般", "急件"] as const).map((p) => <button key={p} type="button" disabled={isBusy(r.id)} aria-pressed={r.priority === p} className={r.priority === p ? (p === "急件" ? "active urgent" : "active") : ""} onClick={() => changePriority(r, p)}>{p}</button>)}</div>}
      {cardError?.id === r.id && <div className="error-box purchase-card-error" role="alert">{cardError.message}</div>}
      {canAdvance && editing?.id !== r.id && (status === "已到貨"
        ? <button type="button" onClick={onGoReceipts}><FileScan size={15} />去建立進貨單</button>
        : <button type="button" disabled={isBusy(r.id) || bulkRunning} onClick={() => moveTo(r, statusSteps[index + 1])}>{isBusy(r.id) ? "更新中…" : NEXT_ACTION_LABEL[status]}<ChevronRight size={15} /></button>)}
    </article>;
  };

  return <><PageHeader title="採購需求" subtitle="從提出、訂購到到貨，清楚追蹤每一項採購；實際入庫請另外到「新增進貨單」建立進貨單。" button="新增採購需求" onClick={onNew} />
    {loadError && <div className="error-box">{loadError}</div>}
    {moved && <div className={moved.error ? "error-box inventory-notice" : "inventory-notice"} role={moved.error ? "alert" : "status"}>
      <span>{movedText}</span>
      {moved.items.length > 0 && <button type="button" className="text-button" onClick={undoMove} disabled={moved.items.some((it) => isBusy(it.request.id))}><Undo2 size={14} />{moved.error && !moved.failed ? "再試一次" : moved.items.length > 1 ? `全部復原（${moved.items.length}）` : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setMoved(null)}><X size={14} /></button>
    </div>}
    {loading && requests.length === 0 && <p>載入採購需求中…</p>}
    {!canAdvance && <div className="setting-note">只有管理員與訂貨管家可以推進採購狀態；你可以新增採購需求並查看進度。</div>}
    <div className="purchase-board">{statusSteps.slice(0, -1).map((status) => { const list = inColumn(status); return <section key={status} className="purchase-column">
      <header><span>{status}</span><b>{list.length}</b></header>
      {canAdvance && NEXT_ACTION_LABEL[status] && list.length >= 2 && <button type="button" className="text-button purchase-column-bulk" disabled={bulkRunning || list.some((r) => isBusy(r.id))} onClick={() => moveAll(list, statusSteps[statusSteps.indexOf(status) + 1])}><Check size={14} />這一欄全部{NEXT_ACTION_LABEL[status]}（{list.length}）</button>}
      {status === "已到貨" && <p className="purchase-column-note">這一欄只是提醒，不會自動增加庫存。到「新增進貨單」輸入後，庫存才會更新。</p>}
      <div className="purchase-column-list">
        {list.length === 0 && <p className="purchase-column-empty">{status === "待確認" ? "目前沒有待確認的需求" : status === "已訂購" ? "目前沒有已訂購、等到貨的需求" : "目前沒有已到貨的需求"}</p>}
        {list.map((r) => card(r, status))}
      </div>
    </section>; })}</div>
    {paused.length > 0 && <section className="purchase-paused">
      <button type="button" className="text-button" aria-expanded={showPaused} onClick={() => setShowPaused((v) => !v)}>{showPaused ? <ChevronUp size={15} /> : <ChevronDown size={15} />}暫緩中（{paused.length}）</button>
      {showPaused && <div className="purchase-paused-list">{paused.map((r) => <article key={r.id} className="purchase-card">
        <div className="purchase-card-head"><div><strong>{r.itemName}</strong><span className="purchase-card-qty">{r.quantity} {r.unit}</span></div></div>
        {r.note && <p>{r.note}</p>}
        <small>{r.requester} · {r.requestedAt}</small>
        {cardError?.id === r.id && <div className="error-box purchase-card-error" role="alert">{cardError.message}</div>}
        {canAdvance && <button type="button" disabled={isBusy(r.id)} onClick={() => moveTo(r, "待確認")}><Undo2 size={15} />恢復到「待確認」</button>}
      </article>)}</div>}
    </section>}
  </>;
}

// 異動歷史查詢：純讀取，資料來源是真實的stock_movements（新增進貨單、盤點、新增異動都會寫進同一張表）。
type MovementFilters = { itemId: string; type: MovementType | ""; operatorId: string; from: string; to: string; q: string };
type MovementOperator = { id: string; name: string; active: boolean };
const EMPTY_MOVEMENT_FILTERS: MovementFilters = { itemId: "", type: "", operatorId: "", from: "", to: "", q: "" };
const MOVEMENT_PAGE_SIZE = 50;
const MOVEMENT_TYPE_HELP: Array<[MovementType, string]> = [
  ["採購入庫", "進貨單確認入庫，或手動記錄的進貨"],
  ["日常領用", "日常用掉的備品、飲品等"],
  ["客房補充", "補到客房的備品"],
  ["食材使用", "廚房做餐用掉的食材"],
  ["損壞", "打破、壞掉不能用"],
  ["過期報廢", "過期丟棄"],
  ["盤點調整", "盤點後，把系統數量改成實際數量的差額"],
];
const movementTone = (label: string): "sage" | "gold" | "red" | "blue" | "neutral" =>
  label === "採購入庫" ? "sage" : label === "盤點調整" ? "gold" : label === "損壞" || label === "過期報廢" ? "red" : "blue";

function movementParams(f: MovementFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (f.itemId) params.set("itemId", f.itemId);
  if (f.type) params.set("movementType", MOVEMENT_TYPE_ENUM[f.type]);
  if (f.operatorId) params.set("operatorId", f.operatorId);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.q) params.set("q", f.q);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

function MovementLogView({ inventory }: { inventory: InventoryItem[] }) {
  const [filters, setFilters] = useState<MovementFilters>(EMPTY_MOVEMENT_FILTERS);
  const [qInput, setQInput] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [rows, setRows] = useState<StockMovementRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // 這批資料是用哪組篩選查出來的：篩選剛換、新資料還沒回來時，不拿舊資料去算「庫存剩」。
  const [loadedKey, setLoadedKey] = useState("");
  const [operators, setOperators] = useState<MovementOperator[]>([]);
  const [itemQuantity, setItemQuantity] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [demo, setDemo] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const seq = useRef(0);
  const todayKey = taipeiDateKey();
  const rangeInvalid = Boolean(filters.from && filters.to && filters.from > filters.to);

  // 備註關鍵字：停止輸入 0.35 秒後才查，不用每打一個字就送一次。
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters((f) => f.q === qInput.trim() ? f : { ...f, q: qInput.trim() }), 350);
    return () => window.clearTimeout(timer);
  }, [qInput]);

  // 換篩選就從第一頁重查；舊請求晚回來的結果會被丟掉，不會蓋掉新結果。
  useEffect(() => {
    if (rangeInvalid) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(""); setMoreError("");
      try {
        const response = await fetch(`/api/inventory/movements?${movementParams(filters, { limit: String(MOVEMENT_PAGE_SIZE) })}`, { signal: controller.signal });
        const data = await response.json() as { movements?: StockMovementRecord[]; total?: number; hasMore?: boolean; operators?: MovementOperator[]; itemQuantity?: number | null; demo?: boolean; error?: string };
        if (mine !== seq.current) return;
        if (!response.ok) throw new Error(data.error || "讀取異動紀錄失敗");
        setRows(data.movements || []);
        setTotal(data.total ?? (data.movements || []).length);
        setHasMore(Boolean(data.hasMore));
        setLoadedKey(JSON.stringify(filters));
        if (data.operators) setOperators(data.operators);
        setItemQuantity(data.itemQuantity ?? null);
        setDemo(Boolean(data.demo));
      } catch (reason) {
        if (mine !== seq.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setRows([]); setTotal(0); setHasMore(false); setLoadedKey("");
        setError(reason instanceof Error ? reason.message : "讀取異動紀錄失敗，請稍後再試。");
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filters, reloadTick, rangeInvalid]);

  const loadMore = async () => {
    const mine = seq.current;
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true); setMoreError("");
    try {
      // 用「上一筆的時間與 id」當游標往更早翻，翻頁期間有新異動寫進來也不會重複或漏掉。
      const response = await fetch(`/api/inventory/movements?${movementParams(filters, { limit: String(MOVEMENT_PAGE_SIZE), beforeAt: last.createdAt, beforeId: last.id })}`);
      const data = await response.json() as { movements?: StockMovementRecord[]; hasMore?: boolean; error?: string };
      if (mine !== seq.current) return;
      if (!response.ok) throw new Error(data.error || "讀取異動紀錄失敗");
      setRows((current) => { const seen = new Set(current.map((r) => r.id)); return [...current, ...(data.movements || []).filter((r) => !seen.has(r.id))]; });
      setHasMore(Boolean(data.hasMore));
    } catch (reason) {
      if (mine === seq.current) setMoreError(reason instanceof Error ? reason.message : "讀取失敗，請稍後再試。");
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true); setExportMessage("");
    try {
      const response = await fetch(`/api/inventory/movements?${movementParams(filters, { export: "1" })}`);
      const data = await response.json() as { movements?: StockMovementRecord[]; total?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "匯出失敗");
      const list = data.movements || [];
      const blob = new Blob([movementsToCsv(list)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `異動紀錄_${todayKey}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportMessage(`已匯出 ${list.length} 筆${(data.total ?? 0) > list.length ? `（符合條件共 ${data.total} 筆，匯出最新的 ${list.length} 筆，請縮小日期範圍）` : ""}。`);
    } catch (reason) {
      setExportMessage(`匯出失敗：${reason instanceof Error ? reason.message : "請稍後再試。"}`);
    } finally {
      setExporting(false);
    }
  };

  const set = (patch: Partial<MovementFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const preset = detectPreset(filters.from, filters.to, todayKey);
  const hasFilter = JSON.stringify(filters) !== JSON.stringify(EMPTY_MOVEMENT_FILTERS) || qInput !== "";
  const clearFilters = () => { setFilters(EMPTY_MOVEMENT_FILTERS); setQInput(""); setItemSearch(""); };
  const itemOptions = inventory
    .filter((item) => item.id === filters.itemId || ((showInactive || item.active) && (!itemSearch.trim() || item.name.toLowerCase().includes(itemSearch.trim().toLowerCase()))))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  // 單一品項、而且沒有截止日期／類型／操作人／備註篩選時，可以用「目前庫存」往回推每筆之後剩多少。
  const showBalance = Boolean(filters.itemId) && !filters.to && !filters.type && !filters.operatorId && !filters.q && itemQuantity !== null && !loading && loadedKey === JSON.stringify(filters);
  const balances = useMemo(() => showBalance ? balancesAfter(rows, itemQuantity as number) : null, [showBalance, rows, itemQuantity]);
  const groups = useMemo(() => groupByDay(rows), [rows]);
  const columns = showBalance ? 8 : 7;

  return <><PageHeader title="異動紀錄" subtitle="新增進貨單、盤點修正、新增異動，所有真正影響庫存數量的紀錄都會出現在這裡。" />
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，無法顯示異動紀錄。</span></div>}
    <details className="movement-help"><summary>各種異動類型的意思</summary>
      <dl>{MOVEMENT_TYPE_HELP.map(([label, text]) => <div key={label}><dt><Pill tone={movementTone(label)}>{label}</Pill></dt><dd>{text}</dd></div>)}</dl>
    </details>
    <div className="movement-filters">
      <div className="movement-range">
        <div className="stock-filter" role="group" aria-label="日期範圍">
          {([["all", "全部時間"], ["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"]] as const).map(([id, label]) => <button key={id} type="button" className={preset === id ? "active" : ""} aria-pressed={preset === id} onClick={() => set(presetRange(id, todayKey))}>{label}</button>)}
        </div>
        <label className="date-field">從<input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="date-field">到<input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
      </div>
      <div className="toolbar">
        <div className="movement-item-picker">
          <input type="search" placeholder="輸入品項名稱縮小選單" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} aria-label="輸入品項名稱縮小品項選單" />
          <select value={filters.itemId} onChange={(e) => set({ itemId: e.target.value })} aria-label="品項"><option value="">全部品項</option>{itemOptions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.active ? "" : "（已停用）"}</option>)}</select>
          <label className="inline-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />含已停用品項</label>
        </div>
        <select value={filters.type} onChange={(e) => set({ type: e.target.value as MovementType | "" })} aria-label="異動類型"><option value="">全部類型</option>{(Object.keys(MOVEMENT_TYPE_ENUM) as MovementType[]).map((t) => <option key={t}>{t}</option>)}</select>
        <select value={filters.operatorId} onChange={(e) => set({ operatorId: e.target.value })} aria-label="操作人"><option value="">全部操作人</option>{operators.map((o) => <option key={o.id} value={o.id}>{o.name}{o.active ? "" : "（已停用）"}</option>)}</select>
        <div className="search-box"><Search size={18} /><input placeholder="搜尋備註" value={qInput} onChange={(e) => setQInput(e.target.value)} aria-label="搜尋備註" /></div>
        {hasFilter && <button type="button" className="text-button" onClick={clearFilters}><X size={14} />清除篩選</button>}
      </div>
    </div>
    {rangeInvalid && <div className="error-box" role="alert">開始日期不能比結束日期晚，請重新選擇。</div>}
    {error && <div className="error-box inventory-notice" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => setReloadTick((n) => n + 1)}><RefreshCw size={14} />重新載入</button></div>}
    {!error && !rangeInvalid && !demo && <div className="movement-summary" aria-live="polite">
      <span>{loading && rows.length === 0 ? "載入中…" : <>共 <b>{total}</b> 筆{hasMore && <>，已顯示 {rows.length} 筆</>}{showBalance && <span className="field-hint">　（「庫存剩」是用目前庫存往回推算）</span>}</>}</span>
      <button type="button" className="secondary-button" onClick={exportCsv} disabled={exporting || total === 0}><Download size={15} />{exporting ? "匯出中…" : "匯出 CSV"}</button>
    </div>}
    {exportMessage && <div className={exportMessage.startsWith("匯出失敗") ? "error-box inventory-notice" : "inventory-notice"} role="status"><span>{exportMessage}</span><button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setExportMessage("")}><X size={14} /></button></div>}
    {!error && !rangeInvalid && (loading && rows.length === 0
      ? <p className="panel-empty">載入異動紀錄中…</p>
      : rows.length === 0
        ? <div className="report-empty-state"><AlertTriangle size={28} /><strong>{hasFilter ? "沒有符合條件的異動紀錄" : "還沒有異動紀錄"}</strong><p>{hasFilter ? "請調整篩選條件，或清除篩選看全部。" : "到「庫存管理」記錄異動、盤點，或建立進貨單入庫後，紀錄會出現在這裡。"}</p>{hasFilter && <button type="button" className="secondary-button" onClick={clearFilters}>清除篩選</button>}</div>
        : <div className={loading ? "table-card is-refreshing" : "table-card"} aria-busy={loading}><table className="movement-table"><thead><tr><th>時間</th><th>品項</th><th>異動類型</th><th>數量</th>{showBalance && <th title="這筆異動之後的庫存（用目前庫存往回推算）">庫存剩</th>}<th>批次到期日</th><th>操作人</th><th>備註</th></tr></thead>
          <tbody>{groups.map((g) => <Fragment key={g.key}><tr className="day-row"><th colSpan={columns} scope="colgroup">{dayLabel(g.key, todayKey)}</th></tr>{g.rows.map((m) => <tr key={m.id}>
            <td data-label="時間">{formatMovementTime(m.createdAt)}</td>
            <td data-label="品項"><strong>{m.itemName}</strong></td>
            <td data-label="異動類型"><Pill tone={movementTone(m.movementType)}>{m.movementType}</Pill></td>
            <td data-label="數量"><b className={m.quantityChange > 0 ? "positive-text" : "danger-text"}>{formatSignedNumber(m.quantityChange)} {m.unit}</b></td>
            {showBalance && <td data-label="庫存剩">{balances?.get(m.id) == null ? <span className="field-hint" title="跟上一筆是同一次操作，操作完的庫存顯示在這組最上面那一筆">〃</span> : <>{formatNumber(balances.get(m.id))} {m.unit}</>}</td>}
            <td data-label="批次到期日">{m.expiryDate || "—"}</td>
            <td data-label="操作人">{m.operatorName}</td>
            <td data-label="備註">{m.note || "—"}</td>
          </tr>)}</Fragment>)}</tbody></table></div>)}
    {!error && !rangeInvalid && !loading && rows.length > 0 && hasMore && <div className="notes-more">
      {moreError && <div className="error-box" role="alert">{moreError}</div>}
      <button type="button" className="secondary-button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "載入中…" : total > rows.length ? `再載入 ${Math.min(MOVEMENT_PAGE_SIZE, total - rows.length)} 筆（還有 ${total - rows.length} 筆更早的）` : "再載入更早的紀錄"}</button>
    </div>}
  </>;
}


type NoteNotice = { message: string; error?: boolean; restore?: () => Promise<string | void> };
type NoteTab = "open" | "done" | "all";
const NOTES_PAGE_SIZE = 30;
const NOTE_CATEGORY_OPTIONS: HandoverNote["category"][] = ["客人需求", "房務問題", "設備維修", "餐飲", "重要公告"];

function NotesView({ notes, loading, loadError, onRetry, isAdmin, userId, notice, onDismissNotice, onNew, onEdit, onResolve, onDelete }: {
  notes: HandoverNote[];
  loading: boolean;
  loadError: string;
  onRetry: () => void;
  isAdmin: boolean;
  userId: string | null;
  notice: NoteNotice | null;
  onDismissNotice: () => void;
  onNew: () => void;
  onEdit: (note: HandoverNote) => void;
  onResolve: (note: HandoverNote, resolved: boolean) => Promise<void>;
  onDelete: (note: HandoverNote) => void;
}) {
  const [tab, setTab] = useState<NoteTab>("open");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(NOTES_PAGE_SIZE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // 復原失敗的訊息綁在「那一則提示」上；提示換掉（新操作）就不再顯示舊的失敗。
  const [restoreFail, setRestoreFail] = useState<{ notice: NoteNotice; message: string } | null>(null);
  const restoreError = restoreFail && restoreFail.notice === notice ? restoreFail.message : "";
  const q = query.trim().toLowerCase();
  // 分頁籤的數字只看分類與搜尋，不看目前選哪個分頁，切換時數字才不會跳。
  const scoped = notes.filter((n) => (category === "全部" || n.category === category) && (!q || `${n.content} ${n.author}`.toLowerCase().includes(q)));
  const counts = { open: scoped.filter((n) => !n.resolvedAt).length, done: scoped.filter((n) => n.resolvedAt).length, all: scoped.length };
  // 排序：未處理的重要留言最上面，其次未處理，已處理的放最後；同一組內維持新的在前。
  const rank = (n: HandoverNote) => n.resolvedAt ? 2 : n.important ? 0 : 1;
  const shown = scoped
    .filter((n) => tab === "all" || (tab === "open" ? !n.resolvedAt : Boolean(n.resolvedAt)))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map(({ n }) => n);
  const visible = shown.slice(0, limit);
  const filtering = category !== "全部" || q !== "";
  const resolve = async (note: HandoverNote, resolved: boolean) => { setBusyId(note.id); try { await onResolve(note, resolved); } finally { setBusyId(null); } };
  const undoDelete = async () => {
    if (!notice?.restore) return;
    setRestoring(true); setRestoreFail(null);
    try { const error = await notice.restore(); if (error) setRestoreFail({ notice, message: error }); else onDismissNotice(); } finally { setRestoring(false); }
  };
  const emptyText = notes.length === 0 || shown.length > 0 ? null
    : filtering ? "沒有符合的留言。"
    : tab === "open" ? "目前沒有需要接手的留言，都處理完了。"
    : tab === "done" ? "還沒有標成已處理的留言。" : "沒有留言。";

  return <>
    <PageHeader title="交接留言" subtitle="全員都看得到。處理完的留言標成「已處理」，會收進另一個分頁，不會被刪掉。" button="新增交接留言" onClick={onNew} />
    {loadError && <div className="error-box inventory-notice" role="alert"><span>{loadError}</span><button type="button" className="text-button" onClick={onRetry}><RefreshCw size={14} />重新載入</button></div>}
    {notice && <div className={notice.error || restoreError ? "error-box inventory-notice" : "inventory-notice"} role={notice.error || restoreError ? "alert" : "status"}>
      <span>{restoreError ? `復原失敗：${restoreError}` : notice.message}</span>
      {notice.restore && <button type="button" className="text-button" onClick={undoDelete} disabled={restoring}><Undo2 size={14} />{restoring ? "復原中…" : restoreError ? "再試一次" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={onDismissNotice}><X size={14} /></button>
    </div>}
    {loading && notes.length === 0 && !loadError && <p className="panel-empty">載入交接留言中…</p>}
    {notes.length === 0 && !loading && !loadError && <div className="notes-empty">
      <MessageSquareText size={28} />
      <strong>還沒有交接留言</strong>
      <p>客人需求、房務、設備維修、餐飲，下一班需要知道的事都寫在這裡。</p>
      <button type="button" className="primary-button" onClick={onNew}><Plus size={18} />寫第一則留言</button>
    </div>}
    {notes.length > 0 && <>
      <div className="notes-toolbar">
        <div className="stock-filter" role="group" aria-label="留言狀態">
          {([["open", "未處理"], ["done", "已處理"], ["all", "全部"]] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? "active" : ""} aria-pressed={tab === id} onClick={() => { setTab(id); setLimit(NOTES_PAGE_SIZE); }}>{label}<span>{counts[id]}</span></button>)}
        </div>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setLimit(NOTES_PAGE_SIZE); }} aria-label="依分類篩選"><option value="全部">全部分類</option>{NOTE_CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}</select>
        <div className="search-box"><Search size={18} /><input placeholder="搜尋留言內容或作者" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(NOTES_PAGE_SIZE); }} aria-label="搜尋留言內容或作者" /></div>
      </div>
      {emptyText && <div className="notes-empty compact"><p>{emptyText}</p>{filtering && <button type="button" className="secondary-button" onClick={() => { setCategory("全部"); setQuery(""); }}>清除篩選</button>}</div>}
      <div className="notes-page">{visible.map((note) => {
        // userId 為 null 是示範模式（本機資料，沒有帳號），全部可以編輯。
        const canEdit = isAdmin || userId === null || note.authorId === userId;
        const done = Boolean(note.resolvedAt);
        return <article key={note.id} className={done ? "note-done" : note.important ? "note-important" : ""}>
          <header>
            <Pill tone={note.important && !done ? "red" : "sage"}>{note.category}</Pill>
            {note.important && !done && <span className="important-label">重要</span>}
            {done && <span className="note-done-label"><Check size={13} />已處理</span>}
            {(canEdit || isAdmin) && <span className="note-menu"><ActionMenu label="這則留言的更多操作" items={[
              { label: "編輯", icon: Pencil, onClick: () => onEdit(note), hidden: !canEdit },
              { label: "刪除", icon: Trash2, onClick: () => onDelete(note), danger: true, hidden: !isAdmin },
            ]} /></span>}
          </header>
          <p>{note.content}</p>
          <footer>
            <span>{note.author} · {note.createdAt}{note.editedAt && <em className="note-edited" title={`最後編輯：${note.editedAt}`}>（已編輯）</em>}</span>
            <button type="button" className="row-text-button" disabled={busyId === note.id} onClick={() => resolve(note, !done)}>{done ? <><Undo2 size={14} />改回未處理</> : <><Check size={14} />標記已處理</>}</button>
          </footer>
          {done && <small className="note-resolved-by">{note.resolvedBy ?? "—"} 於 {note.resolvedAt} 處理</small>}
        </article>;
      })}</div>
      {shown.length > visible.length && <div className="notes-more"><button type="button" className="secondary-button" onClick={() => setLimit(limit + NOTES_PAGE_SIZE)}>再顯示 {Math.min(NOTES_PAGE_SIZE, shown.length - visible.length)} 則（還有 {shown.length - visible.length} 則）</button></div>}
    </>}
  </>;
}

function Status({ status }: { status: PurchaseStatus }) {
  // 紅色只留給真正要注意的（低庫存、過期、急件）；待確認只是還沒處理，用中性色。
  const tone = status === "待確認" ? "neutral" : status === "已訂購" ? "blue" : "gold";
  return <Pill tone={tone}>{status}</Pill>;
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal"><header><div><h2>{title}</h2><p>{subtitle}</p></div><button aria-label="關閉" title="關閉" onClick={onClose}><X /></button></header>{children}</div></div>;
}

function PurchaseModal({ inventory, categories, openRequests, initialItem, onClose, onSave, onCreateItem }: {
  inventory: InventoryItem[];
  categories: string[];
  openRequests: PurchaseRequest[];
  initialItem: string;
  onClose: () => void;
  onSave: (p: PurchaseDraft) => Promise<string | void>;
  onCreateItem: (payload: InventoryItemInput) => Promise<InventoryItem | string>;
}) {
  const first = inventory.find((i) => i.name === initialItem) || inventory[0];
  const [mode, setMode] = useState<"existing" | "new">(inventory.length > 0 ? "existing" : "new");
  const [itemName, setItemName] = useState(first?.name ?? "");
  const current = inventory.find((i) => i.name === itemName) || first;
  // 預設數量＝建議採購量；建議採購量是0（沒設定）時用1，免得送出時才被「數量必須大於0」擋下。
  const defaultQty = (i?: InventoryItem) => (i && i.suggestedPurchase > 0 ? i.suggestedPurchase : 1);
  const [quantity, setQuantity] = useState(defaultQty(current));
  // 找品項：先選大分類（可選全部），低庫存的排最前面，其他照名稱排序。
  const [pickCategory, setPickCategory] = useState("全部");
  const pickCategories = Array.from(new Set(inventory.map((i) => i.category))).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  const isLowItem = (i: InventoryItem) => Boolean(getLowStockReason(i));
  const options = inventory
    .filter((i) => pickCategory === "全部" || i.category === pickCategory)
    .sort((a, b) => Number(isLowItem(b)) - Number(isLowItem(a)) || a.name.localeCompare(b.name, "zh-Hant"));
  const pickItem = (name: string) => { setItemName(name); const next = inventory.find((i) => i.name === name); if (next) setQuantity(defaultQty(next)); };
  // 同一個品項已經有還沒處理完的需求時提醒（不擋），避免兩個人各提一張、買了兩倍。
  const openSame = current ? openRequests.filter((r) => ["待確認", "已訂購", "已到貨"].includes(r.status) && (r.inventoryItemId ? r.inventoryItemId === current.id : r.itemName === current.name)) : [];
  const [priority, setPriority] = useState<"一般" | "急件">("一般");
  const [note, setNote] = useState("");

  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState(categories[0] ?? "");
  const [newUnit, setNewUnit] = useState("個");
  const [newSafetyStock, setNewSafetyStock] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (mode === "existing") {
      if (!current) { setError("請選擇品項。"); return; }
      setSubmitting(true);
      const saveError = await onSave({ itemName: current.name, inventoryItemId: current.id, quantity, unit: current.unit, priority, note });
      setSubmitting(false);
      if (saveError) setError(saveError);
      return;
    }

    if (!newName.trim()) { setError("請輸入品項名稱。"); return; }
    if (!newCategory) { setError("請選擇大分類。"); return; }
    if (!newUnit.trim()) { setError("請輸入計算單位。"); return; }
    setSubmitting(true);
    const result = await onCreateItem({
      name: newName.trim(), category: newCategory, unit: newUnit.trim() || "個",
      safetyStock: newSafetyStock, suggestedPurchase: quantity, usageForecastEnabled: false,
    });
    setSubmitting(false);
    if (typeof result === "string") { setError(result); return; }
    setSubmitting(true);
    const saveError = await onSave({ itemName: result.name, inventoryItemId: result.id, quantity, unit: result.unit, priority, note });
    setSubmitting(false);
    if (saveError) setError(saveError);
  };

  return <ModalShell title="新增採購需求" subtitle="提出後將進入待確認清單" onClose={onClose}><form onSubmit={submit}>
    <div className="mode-toggle">
      <button type="button" className={mode === "existing" ? "primary-button" : "secondary-button"} disabled={inventory.length === 0} onClick={() => setMode("existing")}>從現有庫存選擇</button>
      <button type="button" className={mode === "new" ? "primary-button" : "secondary-button"} onClick={() => setMode("new")}>建立新庫存品項</button>
    </div>

    {mode === "existing" ? <>
      {inventory.length === 0 ? <div className="warning-box"><span>• 目前沒有可選擇的庫存品項，請改用「建立新庫存品項」。</span></div> : <>
        <div className="form-grid">
          <label>大分類<select value={pickCategory} onChange={(e) => { const c = e.target.value; setPickCategory(c); const list = inventory.filter((i) => c === "全部" || i.category === c); if (current && !list.some((i) => i.id === current.id)) { const firstInList = [...list].sort((a, b) => Number(isLowItem(b)) - Number(isLowItem(a)) || a.name.localeCompare(b.name, "zh-Hant"))[0]; if (firstInList) pickItem(firstInList.name); } }}><option>全部</option>{pickCategories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>品項<select value={options.some((i) => i.name === itemName) ? itemName : (options[0]?.name ?? "")} onChange={(e) => pickItem(e.target.value)}>{options.map((i) => <option key={i.id} value={i.name}>{i.name}{isLowItem(i) ? "（低庫存）" : ""}</option>)}</select></label>
        </div>
        {current && <div className="stock-hint">目前庫存：{formatNumber(current.quantity)}{current.unit}　安全庫存：{formatNumber(current.safetyStock)}{current.unit}</div>}
        {openSame.length > 0 && <div className="warning-box"><span>• 「{current?.name}」已經有 {openSame.length} 張還沒處理完的需求：{openSame.map((r) => `${r.quantity}${r.unit}（${r.status}${r.priority === "急件" ? "・急件" : ""}）`).join("、")}。確定還要再提一張嗎？如果是要追加，可以照樣送出。</span></div>}
      </>}
    </> : <>
      {categories.length === 0 && <div className="warning-box"><span>• 目前沒有啟用中的分類，請先到「系統設定」新增或啟用分類。</span></div>}
      <label>新品項名稱<input required value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：客房瓶裝水" /></label>
      <div className="form-grid">
        <label>大分類<select required disabled={categories.length === 0} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}><option value="">請選擇</option>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>計算單位<input required value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="包、瓶、公斤" /></label>
      </div>
      <label>安全庫存<input type="number" min="0" step="0.5" value={newSafetyStock} onChange={(e) => setNewSafetyStock(Math.max(0, roundQuantity(Number(e.target.value))))} /><small className="field-hint">庫存少於這個數量就會提醒補貨（剛好等於不算）；設 0 就不提醒。</small></label>
    </>}

    <div className="form-grid"><label>採購數量<input type="number" min="0.5" step="0.5" value={quantity} onChange={(e) => setQuantity(roundQuantity(Number(e.target.value)))} /></label><label>急迫程度<select value={priority} onChange={(e) => setPriority(e.target.value as "一般" | "急件")}><option>一般</option><option>急件</option></select></label></div>
    <label>原因或備註<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：明天有12位早餐客人" /></label>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "建立中…" : "送出採購需求"}</button></div>
  </form></ModalShell>;
}

const MOVEMENT_TYPES = Object.keys(MOVEMENT_TYPE_ENUM) as MovementType[];

// 新增庫存異動：跟「盤點／修正庫存」一樣真的呼叫record_stock_movement，差別是這裡要選異動類型
// （採購入庫／日常領用／客房補充／食材使用／損壞／過期報廢／盤點調整），盤點只單純比對系統與實際數量。
function batchLabel(batch: InventoryBatch, unit: string): string {
  return `${batch.expiryDate ? `${batch.expiryDate} 到期` : "未標日期"}（${formatNumber(batch.quantity)}${unit}）`;
}

const AUTO_BATCH = "";

// 異動類型的選單順序：最常用的「用掉」放前面，採購入庫放最後（一般進貨走進貨單）。
const MOVEMENT_TYPE_ORDER: MovementType[] = ["日常領用", "客房補充", "食材使用", "損壞", "過期報廢", "盤點調整", "採購入庫"];

function MovementEntryModal({ item, onClose, onConfirm, onGoReceipts }: {
  item: InventoryItem;
  onClose: () => void;
  onConfirm: (movementType: string, changeAmount: number, note?: string, batch?: { batchId?: string; expiryDate?: string }) => Promise<string | void>;
  onGoReceipts: () => void;
}) {
  // 預設「日常領用」：以前預設採購入庫，員工容易在這裡入庫一次、進貨單又入庫一次。
  const [type, setType] = useState<MovementType>("日常領用");
  const [direction, setDirection] = useState<"increase" | "decrease">("increase");
  const [amount, setAmount] = useState(1);
  const [expiryDate, setExpiryDate] = useState("");
  const [batchId, setBatchId] = useState(AUTO_BATCH);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fixedDirection = MOVEMENT_TYPE_DEFAULT_DIRECTION[type];
  const effectiveDirection = fixedDirection ?? direction;
  // 過期報廢一定要指定是哪一批（預設最早到期的那批）；其他減少的類型預設先到期先出。
  const mustPickBatch = type === "過期報廢";
  const effectiveBatchId = mustPickBatch && batchId === AUTO_BATCH ? (item.batches[0]?.id ?? AUTO_BATCH) : batchId;
  const selectedBatch = item.batches.find((b) => b.id === effectiveBatchId);
  const available = selectedBatch ? selectedBatch.quantity : item.quantity;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(amount > 0)) { setError("數量必須大於0。"); return; }
    if (effectiveDirection === "decrease" && amount > available) { setError(`${selectedBatch ? "這批" : "目前"}只剩${formatNumber(available)}${item.unit}，無法減少${formatNumber(amount)}${item.unit}。`); return; }
    setSubmitting(true);
    setError("");
    const changeAmount = effectiveDirection === "increase" ? Math.abs(amount) : -Math.abs(amount);
    const batch = effectiveDirection === "increase"
      ? { expiryDate: expiryDate || undefined }
      : { batchId: effectiveBatchId || undefined };
    const saveError = await onConfirm(MOVEMENT_TYPE_ENUM[type], changeAmount, note.trim() || undefined, batch);
    setSubmitting(false);
    if (saveError) setError(saveError); else onClose();
  };

  return <ModalShell title="新增庫存異動" subtitle={`品項：${item.name}`} onClose={onClose}><form onSubmit={submit}>
    <p className="modal-lead">記一筆用掉、補房、損壞或報廢。如果是數完要改成正確數字，請改用「盤點」。</p>
    <div className="stock-hint">目前庫存：{formatNumber(item.quantity)} {item.unit}</div>
    <label>異動類型<select value={type} onChange={(e) => { setType(e.target.value as MovementType); setBatchId(AUTO_BATCH); }}>{MOVEMENT_TYPE_ORDER.filter((t) => MOVEMENT_TYPES.includes(t)).map((t) => <option key={t}>{t}</option>)}</select></label>
    {type === "採購入庫" && <div className="warning-box"><span>有進貨單的請用「新增進貨單」入庫，這裡只補登沒有單據的進貨，不然同一批會入庫兩次。</span><button type="button" className="text-button" onClick={onGoReceipts}>去新增進貨單<ChevronRight size={14} /></button></div>}
    <div className="form-grid">
      <label>方向<select value={effectiveDirection} disabled={Boolean(fixedDirection)} onChange={(e) => setDirection(e.target.value as "increase" | "decrease")}><option value="increase">增加</option><option value="decrease">減少</option></select></label>
      <label>數量（{item.unit}）<input type="number" min="0.5" step="0.5" value={amount} onChange={(e) => setAmount(roundQuantity(Number(e.target.value)))} /></label>
    </div>
    {effectiveDirection === "increase"
      ? <label>這批的有效期限（可不填；跟現有批次同一天會併在一起）<input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></label>
      : item.batches.length === 0
        ? <div className="warning-box"><span>• 這個品項目前沒有庫存，無法減少。</span></div>
        : <label>從哪一批扣<select value={effectiveBatchId} onChange={(e) => setBatchId(e.target.value)}>
            {!mustPickBatch && <option value={AUTO_BATCH}>自動：先到期的先扣</option>}
            {item.batches.map((b) => <option key={b.id} value={b.id}>{batchLabel(b, item.unit)}</option>)}
          </select></label>}
    <label>備註（可不填）<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="填寫用途或調整原因" /></label>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "儲存中…" : "儲存異動"}</button></div>
  </form></ModalShell>;
}

function ItemModal({ categories, item, onClose, onSave }: {
  categories: string[];
  item: InventoryItem | null;
  onClose: () => void;
  onSave: (payload: InventoryItemInput) => Promise<string | void>;
}) {
  const isEdit = Boolean(item);
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? categories[0] ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "個");
  const [safetyStock, setSafetyStock] = useState(item?.safetyStock ?? 0);
  const [suggestedPurchase, setSuggestedPurchase] = useState(item?.suggestedPurchase ?? 1);
  const [supplier, setSupplier] = useState(item?.supplier ?? "");
  const [usageForecastEnabled, setUsageForecastEnabled] = useState(item?.usageForecastEnabled ?? false);
  const [estimatedUsage, setEstimatedUsage] = useState(item?.estimatedUsage ?? 1);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>(item?.usagePeriod ?? "daily");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !category) return;
    if (usageForecastEnabled && !(estimatedUsage > 0)) { setError("預估使用量必須大於0。"); return; }
    setSubmitting(true);
    setError("");
    const saveError = await onSave({
      name: name.trim(),
      category,
      unit: unit.trim() || "個",
      safetyStock,
      suggestedPurchase,
      supplier: supplier.trim() || undefined,
      usageForecastEnabled,
      estimatedUsage: usageForecastEnabled ? estimatedUsage : undefined,
      usagePeriod: usageForecastEnabled ? usagePeriod : undefined,
    });
    setSubmitting(false);
    if (saveError) setError(saveError);
  };

  return <ModalShell title={isEdit ? "編輯庫存品項" : "新增庫存品項"} subtitle={isEdit ? "更新品項的基本資料" : "建立後即可採購、入庫與設定低庫存提醒"} onClose={onClose}><form onSubmit={submit}>
    <label>品項名稱<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：客房瓶裝水" /></label>
    {categories.length === 0 && <div className="warning-box"><span>• 目前沒有啟用中的分類，請先到「系統設定」新增或啟用分類。</span></div>}
    <div className="form-grid"><label>分類<select required disabled={categories.length === 0} value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((name) => <option key={name}>{name}</option>)}</select></label><label>計算單位<input required value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="包、瓶、公斤" /></label></div>
    <div className="form-grid"><label>安全庫存<input type="number" min="0" step="0.5" value={safetyStock} onChange={(e) => setSafetyStock(Math.max(0, roundQuantity(Number(e.target.value))))} /><small className="field-hint">庫存少於這個數量就會提醒補貨（剛好等於不算）；設 0 就不提醒。</small></label><label>建議採購量<input type="number" min="0" step="1" value={suggestedPurchase} onChange={(e) => setSuggestedPurchase(Math.round(Number(e.target.value)))} /><small className="field-hint">按「採購」時預設要買的數量，之後還可以改。</small></label></div>
    <label>供應商<input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="可稍後設定" /></label>
    <div className="setting-note">有效期限改在入庫時填寫（新增進貨單或新增異動），同一品項可以有多個不同日期。</div>
    <label className="check-label"><input type="checkbox" checked={usageForecastEnabled} onChange={(e) => setUsageForecastEnabled(e.target.checked)} />啟用預估使用量</label>
    {usageForecastEnabled && <div className="form-grid"><label>預估使用量（{unit || "單位"}）<input required type="number" min="1" step="1" value={estimatedUsage} onChange={(e) => setEstimatedUsage(Math.round(Number(e.target.value)))} /></label><label>使用週期<select value={usagePeriod} onChange={(e) => setUsagePeriod(e.target.value as UsagePeriod)}><option value="daily">每日</option><option value="weekly">每週</option><option value="monthly">每月</option></select></label></div>}
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={categories.length === 0 || submitting}>{submitting ? "儲存中…" : isEdit ? "儲存變更" : "建立品項"}</button></div>
  </form></ModalShell>;
}

function ConfirmDeleteItemModal({ item, onClose, onConfirm }: { item: InventoryItem; onClose: () => void; onConfirm: () => Promise<string | void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setSubmitting(true);
    setError("");
    const deleteError = await onConfirm();
    setSubmitting(false);
    if (deleteError) setError(deleteError); else onClose();
  };

  return <ModalShell title="刪除庫存品項" subtitle="此操作無法復原" onClose={onClose}>
    <p>確定要永久刪除「<strong>{item.name}</strong>」嗎？</p>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={confirm} disabled={submitting}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
  </ModalShell>;
}

function ConfirmDeleteNoteModal({ note, onClose, onConfirm }: { note: HandoverNote; onClose: () => void; onConfirm: () => Promise<string | void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    setSubmitting(true);
    setError("");
    const deleteError = await onConfirm();
    setSubmitting(false);
    if (deleteError) setError(deleteError); else onClose();
  };

  return <ModalShell title="刪除交接留言" subtitle="刪除後可以馬上復原" onClose={onClose}>
    <p>確定要刪除這則留言嗎？</p>
    <div className="note-delete-preview"><Pill tone={note.important ? "red" : "sage"}>{note.category}</Pill><p>{note.content}</p><small>{note.author} · {note.createdAt}</small></div>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" onClick={confirm} disabled={submitting}>{submitting ? "刪除中…" : "確定刪除"}</button></div>
  </ModalShell>;
}

// 依批次盤點：每一批分別輸入實際數量；盤點時多找到、系統裡沒有的庫存，用「新增一個日期」補上。
function StockCountModal({ item, onClose, onConfirm }: { item: InventoryItem; onClose: () => void; onConfirm: (counts: StocktakeCount[], note?: string) => Promise<string | void> }) {
  const [actuals, setActuals] = useState<Record<string, number>>(() => Object.fromEntries(item.batches.map((b) => [b.id, b.quantity])));
  const [extraRows, setExtraRows] = useState<Array<{ id: string; expiryDate: string; actual: number }>>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const batchCounts = item.batches
    .filter((b) => roundQuantity(actuals[b.id] ?? b.quantity) !== b.quantity)
    .map((b) => ({ batchId: b.id, actual: roundQuantity(actuals[b.id] ?? b.quantity) }));
  const extraCounts = extraRows.filter((row) => row.actual > 0).map((row) => ({ expiryDate: row.expiryDate || undefined, actual: roundQuantity(row.actual) }));
  const counts: StocktakeCount[] = [...batchCounts, ...extraCounts];
  const newTotal = item.batches.reduce((sum, b) => sum + roundQuantity(actuals[b.id] ?? b.quantity), 0) + extraCounts.reduce((sum, c) => sum + c.actual, 0);
  const diff = newTotal - item.quantity;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (counts.length === 0) return;
    setSubmitting(true);
    setError("");
    const saveError = await onConfirm(counts, note.trim() || undefined);
    setSubmitting(false);
    if (saveError) setError(saveError); else onClose();
  };

  return <ModalShell title="盤點／修正庫存" subtitle={`品項：${item.name}`} onClose={onClose}><form onSubmit={submit}>
    <p className="modal-lead">數完實際數量填進來，系統會自動算出差多少。東西用掉或報廢請改用「異動」。</p>
    <div className="stock-hint">系統目前數量：{formatNumber(item.quantity)} {item.unit}{item.batches.length > 1 ? `（${item.batches.length}批）` : ""}</div>
    {item.batches.map((b) => <label key={b.id}>{b.expiryDate ? `${b.expiryDate} 到期` : "未標日期"}：系統 {formatNumber(b.quantity)}{item.unit}，實際
      <input type="number" min="0" step="0.5" value={actuals[b.id] ?? b.quantity} onChange={(e) => setActuals({ ...actuals, [b.id]: Math.max(0, roundQuantity(Number(e.target.value))) })} />
    </label>)}
    {extraRows.map((row) => <div key={row.id} className="form-grid">
      <label>多找到的有效期限（可不填）<input type="date" value={row.expiryDate} onChange={(e) => setExtraRows(extraRows.map((r) => r.id === row.id ? { ...r, expiryDate: e.target.value } : r))} /></label>
      <label>數量（{item.unit}）<input type="number" min="0" step="0.5" value={row.actual} onChange={(e) => setExtraRows(extraRows.map((r) => r.id === row.id ? { ...r, actual: Math.max(0, roundQuantity(Number(e.target.value))) } : r))} /></label>
    </div>)}
    <button type="button" className="text-button" onClick={() => setExtraRows([...extraRows, { id: generateId(), expiryDate: "", actual: 1 }])}><Plus size={15} />{item.batches.length === 0 ? "新增庫存（含有效期限）" : "新增一個日期（盤點時多找到的）"}</button>
    {counts.length === 0 ? <div className="setting-note">庫存數量一致，不需要建立異動紀錄。</div> : <div className={`stock-hint ${diff > 0 ? "positive-text" : diff < 0 ? "danger-text" : ""}`}>盤點後總數：{formatNumber(newTotal)} {item.unit}（差異 {formatSignedNumber(diff)}）</div>}
    {counts.length > 0 && isLargeStockDiff(item.quantity, newTotal) && <div className="warning-box"><span>跟系統差很多，請再數一次，或確認數的單位是不是「{item.unit}」。確定沒錯可以直接送出。</span></div>}
    <label>修正原因或備註（可不填）<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：季度盤點、破損報廢" /></label>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={counts.length === 0 || submitting}>{submitting ? "儲存中…" : "確認修正庫存"}</button></div>
  </form></ModalShell>;
}

function NoteModal({ note, onClose, onSave }: { note?: HandoverNote; onClose: () => void; onSave: (n: NoteDraft) => Promise<string | void> }) {
  const [category, setCategory] = useState<HandoverNote["category"]>(note?.category ?? "房務問題");
  const [content, setContent] = useState(note?.content ?? "");
  const [important, setImportant] = useState(note?.important ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [askDiscard, setAskDiscard] = useState(false);
  const editing = Boolean(note);
  // 有寫了東西、還沒送出就要關：先問一次，不要默默丟掉草稿。
  const dirty = note ? content !== note.content || category !== note.category || important !== note.important : content.trim() !== "";
  // 送出中不能關：關了的話，萬一失敗草稿和錯誤訊息都會跟著消失。
  const tryClose = () => { if (submitting) return; if (dirty) setAskDiscard(true); else onClose(); };
  return <ModalShell title={editing ? "編輯交接留言" : "新增交接留言"} subtitle={editing ? "修改後會顯示「已編輯」，其他人看得到" : "重要事項請開啟標記，讓下一班人員優先看到"} onClose={tryClose}>
    <form onSubmit={async (e) => { e.preventDefault(); if (!content.trim()) return; setSubmitting(true); setError(""); setAskDiscard(false); const saveError = await onSave({ category, content: content.trim(), important }); setSubmitting(false); if (saveError) setError(saveError); }}>
      <label>分類<select value={category} onChange={(e) => setCategory(e.target.value as HandoverNote["category"])}>{NOTE_CATEGORY_OPTIONS.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>留言內容<textarea required maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="請清楚寫下需要接續處理的事情" autoFocus /><small className="field-hint">{content.length} / 2000</small></label>
      <label className="check-label"><input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />標記為重要事項</label>
      <p className="field-hint">「重要」會讓留言排在最上面並標紅，處理完才會收起來；「重要公告」只是分類，用來放給全員的通知。</p>
      {error && <div className="error-box">{error}</div>}
      {askDiscard
        ? <div className="warning-box discard-ask"><span>這則留言還沒送出，確定要放棄嗎？</span><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAskDiscard(false)}>繼續編輯</button><button type="button" className="secondary-button" onClick={onClose}>放棄</button></div></div>
        : <div className="modal-actions"><button type="button" className="secondary-button" onClick={tryClose}>取消</button><button className="primary-button" disabled={submitting || !content.trim() || (editing && !dirty)} title={editing && !dirty ? "還沒有修改任何內容" : undefined}>{submitting ? "送出中…" : editing ? "儲存修改" : "新增留言"}</button></div>}
    </form>
  </ModalShell>;
}
