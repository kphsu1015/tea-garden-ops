"use client";

import {
  AlertTriangle, Archive, BarChart3, Bell, Box, Check, ChevronDown, ChevronRight, ChevronUp, ClipboardCheck, ClipboardList,
  Clock3, Eye, EyeOff, FileScan, History, LogOut, Menu, MessageSquareText, Pencil, Plus, Power, Search, Settings,
  MoreHorizontal, PauseCircle, ShoppingCart, Trash2, Undo2, Users, X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { initialNotes, initialPurchases } from "@/lib/demo-data";
import { EXPIRY_WARNING_DAYS, estimatedRemainingLabel, expiryLabel, getExpiringBatches, getLowStockReason, lowStockReasonLabel, MOVEMENT_TYPE_DEFAULT_DIRECTION, MOVEMENT_TYPE_ENUM, periodFrequencyLabel, roundQuantity, taipeiDateKey, type ExpiringBatch } from "@/lib/inventory";
import type { StockMovementRecord } from "@/lib/movements";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  // silent：背景同步時不顯示「載入中」，失敗也不蓋掉畫面上已有的資料。
  const refresh = async (silent = false) => {
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch("/api/categories");
      const data = await response.json() as { categories?: InventoryCategory[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取分類失敗");
      setCategories(data.categories || []);
      setDemo(Boolean(data.demo));
      setError("");
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : "讀取分類失敗，請稍後再試。");
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
      await refresh();
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

  const reorderCategory = async (id: string, direction: "up" | "down"): Promise<string | void> => {
    const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = sorted.findIndex((c) => c.id === id);
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || swapIndex < 0 || swapIndex >= sorted.length) return;
    const current = sorted[index];
    const target = sorted[swapIndex];
    return mutate(async () => {
      const [resA, resB] = await Promise.all([
        fetch(`/api/categories/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sortOrder: target.sortOrder }) }),
        fetch(`/api/categories/${target.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sortOrder: current.sortOrder }) }),
      ]);
      return resA.ok ? resB : resA;
    });
  };

  return { categories, loading, error, demo, addCategory, renameCategory, toggleCategoryActive, deleteCategory, reorderCategory, refresh };
}

type StocktakeCount = { batchId: string; actual: number } | { expiryDate?: string; actual: number };

function useInventory() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);

  const refresh = async (silent = false) => {
    if (!silent) { setLoading(true); setError(""); }
    try {
      const response = await fetch("/api/inventory");
      const data = await response.json() as { items?: InventoryItem[]; demo?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error || "讀取庫存失敗");
      setItems(data.items || []);
      setDemo(Boolean(data.demo));
      setError("");
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : "讀取庫存失敗，請稍後再試。");
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
      await refresh();
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
  const stocktake = (id: string, counts: StocktakeCount[], note?: string) => mutate(() => fetch(`/api/inventory/${id}/stocktake`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ counts, note }),
  }));

  return { items, loading, error, demo, addItem, updateItem, setItemActive, deleteItem, countStock, stocktake, refresh, createAndReturnItem };
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

function Pill({ children, tone = "sage" }: { children: React.ReactNode; tone?: "sage" | "gold" | "red" | "blue" }) {
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
  const [deletingNote, setDeletingNote] = useState<HandoverNote | null>(null);
  const [query, setQuery] = useState("");
  // 庫存頁的篩選：從總覽點「低庫存」「即將過期」進來時直接套用；從側邊選單進來回到「全部」。
  const [inventoryFilter, setInventoryFilter] = useState<StockFilter>("all");
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
  const deleteNote = async (id: string): Promise<string | void> => {
    if (!session.configured) {
      setLocalNotes(localNotes.filter((n) => n.id !== id));
      return;
    }
    const error = await requestJson(`/api/notes/${id}`, "DELETE");
    if (error) return error;
    await notesState.refresh(true);
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

  const openView = (next: View) => { setView(next); setMobileNav(false); if (next === "inventory") setInventoryFilter("all"); };
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
          {view === "dashboard" && <Dashboard lowStock={lowStock} pending={pending} expiring={expiring} notes={notes} onView={openView} onInventory={openInventory} onPurchase={() => openPurchaseModal()} />}
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
          {view === "notes" && <NotesView notes={notes} loading={session.configured && notesState.loading} loadError={session.configured ? notesState.error : ""} canManage={role === "admin"} onNew={() => setModal("note")} onDelete={(note) => setDeletingNote(note)} />}
          {view === "staff" && <StaffView canView={role === "admin"} canManage={role === "admin"} currentUserId={session.userId} />}
          {view === "settings" && <SettingsView
            categories={categoryState.categories}
            categoriesLoading={categoryState.loading}
            categoriesError={categoryState.error}
            categoriesDemo={categoryState.demo}
            retentionDays={retentionDays}
            canEditRetention={role === "admin" || role === "purchaser" || !session.configured}
            onAddCategory={categoryState.addCategory}
            onRenameCategory={categoryState.renameCategory}
            onReorderCategory={categoryState.reorderCategory}
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
      {modal === "note" && <NoteModal onClose={() => setModal(null)} onSave={async (draft) => { const error = await addNote(draft); if (error) return error; setModal(null); }} />}
      {deletingItem && <ConfirmDeleteItemModal
        item={deletingItem}
        onClose={() => setDeletingItem(null)}
        onConfirm={() => inventoryState.deleteItem(deletingItem.id)}
      />}
      {countingItem && <StockCountModal
        item={countingItem}
        onClose={() => setCountingItem(null)}
        onConfirm={(counts, note) => inventoryState.stocktake(countingItem.id, counts, note)}
      />}
      {movingItem && <MovementEntryModal
        item={movingItem}
        onClose={() => setMovingItem(null)}
        onConfirm={(movementType, changeAmount, note, batch) => inventoryState.countStock(movingItem.id, changeAmount, note, movementType, batch)}
      />}
      {deletingNote && <ConfirmDeleteNoteModal
        note={deletingNote}
        onClose={() => setDeletingNote(null)}
        onConfirm={() => deleteNote(deletingNote.id)}
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

function Dashboard({ lowStock, pending, expiring, notes, onView, onInventory, onPurchase }: { lowStock: InventoryItem[]; pending: PurchaseRequest[]; expiring: ExpiringBatch[]; notes: HandoverNote[]; onView: (v: View) => void; onInventory: (filter: StockFilter) => void; onPurchase: () => void }) {
  const now = new Date();
  const greeting = greetingForHour(getTaipeiHour(now));
  return <>
    <div className="hero-row"><div><p>{formatTaipeiDateLabel(now)}</p><h1>{greeting}，今天有 <em>{lowStock.length}</em> 項庫存需要注意</h1></div><button className="primary-button" onClick={onPurchase}><Plus size={19} />新增採購需求</button></div>
    <div className="stat-grid">
      <Stat icon={AlertTriangle} label="低庫存" value={lowStock.length} tone="red" onClick={() => onInventory("low")} />
      <Stat icon={ShoppingCart} label="待處理採購" value={pending.length} tone="sage" onClick={() => onView("purchases")} />
      <Stat icon={Clock3} label="即將過期" value={expiring.length} tone="gold" onClick={() => onInventory("expiring")} />
      <Stat icon={MessageSquareText} label="交接留言" value={notes.length} tone="blue" onClick={() => onView("notes")} />
    </div>
    <div className="dashboard-grid">
      <Panel title="低庫存品項" icon={Box} action="查看全部" onAction={() => onInventory("low")}>
        <div className="compact-list">{lowStock.slice(0, 5).map((item) => <div key={item.id}><span className="item-avatar">{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><small>{item.category}</small></div><b>{formatNumber(item.quantity)}{item.unit}</b><span>安全 {formatNumber(item.safetyStock)}{item.unit}</span></div>)}</div>
      </Panel>
      <Panel title="待處理採購" icon={ShoppingCart} action="管理採購" onAction={() => onView("purchases")}>
        <div className="compact-list">{pending.slice(0, 5).map((r) => <div key={r.id}><span className="item-avatar">購</span><div><strong>{r.itemName}</strong><small>{r.requester} · {r.requestedAt.slice(5, 10)}</small></div><b>{r.quantity}{r.unit}</b><Status status={r.status} /></div>)}</div>
      </Panel>
      <Panel title="即將過期食材" icon={Clock3} action="查看庫存" onAction={() => onInventory("expiring")}>
        <div className="expiry-list">{expiring.length === 0 ? <p className="notif-empty">{EXPIRY_WINDOW_LABEL}內沒有到期的批次。</p> : expiring.slice(0, 6).map(({ item, batch, expiryDate, daysLeft }) => <div key={batch.id}><div><strong>{item.name}</strong><small>這批 {formatNumber(batch.quantity)}{item.unit} · {expiryDate} 到期</small></div><Pill tone={daysLeft < 0 ? "red" : "gold"}>{expiryLabel(daysLeft)}</Pill></div>)}</div>
      </Panel>
      <Panel title="最新交接留言" icon={MessageSquareText} action="查看留言" onAction={() => onView("notes")}>
        <div className="note-list">{notes.slice(0, 3).map((note) => <div key={note.id}><span className={note.important ? "note-dot important" : "note-dot"} /><div><strong>{note.content}</strong><small>{note.author} · {note.createdAt}</small></div></div>)}</div>
      </Panel>
    </div>
  </>;
}

function Stat({ icon: Icon, label, value, tone, onClick }: { icon: typeof Box; label: string; value: number; tone: string; onClick: () => void }) {
  return <button className={`stat-card stat-${tone}`} onClick={onClick}><span><Icon size={24} /></span><div><small>{label}</small><strong>{value}</strong></div><ChevronRight size={20} /></button>;
}

function Panel({ title, icon: Icon, action, onAction, children }: { title: string; icon: typeof Box; action: string; onAction: () => void; children: React.ReactNode }) {
  return <article className="panel"><header><h2><Icon size={21} />{title}</h2><button onClick={onAction}>{action}<ChevronRight size={16} /></button></header>{children}</article>;
}

function PageHeader({ title, subtitle, button, onClick }: { title: string; subtitle: string; button?: string; onClick?: () => void }) {
  return <div className="section-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{button && <button className="primary-button" onClick={onClick}><Plus size={18} />{button}</button>}</div>;
}

type StockFilter = "all" | "low" | "expiring";
const STOCK_FILTERS: Array<{ id: StockFilter; label: string }> = [{ id: "all", label: "全部" }, { id: "low", label: "低庫存" }, { id: "expiring", label: "快到期" }];

function InventoryView({ items, filter, setFilter, loading, error, demo, categories, query, setQuery, canManage, canReactivateOrDelete, canCount, onAddItem, onEditItem, onToggleActive, onDeleteItem, onCountItem, onAddMovement, onPurchase }: {
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
}) {
  const [category, setCategory] = useState("全部");
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
  return <><div className="section-header"><div><h1>庫存管理</h1><p>掌握各區備品與食材數量，低於安全庫存或預估用量不足時立即提醒。</p></div><div className="header-actions"><button className="primary-button" onClick={onAddItem} disabled={!canManage}><Plus size={18} />新增品項</button></div></div>
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，目前僅顯示唯讀示範庫存，無法新增／編輯／停用／刪除／盤點。</span></div>}
    {error && <div className="error-box">{error}</div>}
    {toggleNotice && <div className={toggleNotice.error ? "error-box inventory-notice" : "inventory-notice"} role={toggleNotice.error ? "alert" : "status"}>
      <span>{toggleNotice.error ? `「${toggleNotice.item.name}」${toggleNotice.undoFailed ? "復原" : toggleNotice.item.active ? "停用" : "啟用"}失敗：${toggleNotice.error}` : toggleNotice.nowActive ? `已重新啟用「${toggleNotice.item.name}」` : `已停用「${toggleNotice.item.name}」，它不會再出現在清單和低庫存提醒裡。勾選「顯示停用品項」可以看到它。`}</span>
      {canUndo && <button type="button" className="text-button" onClick={undoToggle}><Undo2 size={14} />{toggleNotice.undoFailed ? "再試一次" : "復原"}</button>}
      <button type="button" className="notice-close" aria-label="關閉提示" title="關閉提示" onClick={() => setToggleNotice(null)}><X size={14} /></button>
    </div>}
    <div className="toolbar">
      <div className="stock-filter" role="group" aria-label="篩選庫存">{STOCK_FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>{f.label}<span>{counts[f.id]}</span></button>)}</div>
      <div className="search-box"><Search size={18} /><input placeholder="搜尋品項或供應商" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜尋品項或供應商" /></div>
      <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="分類"><option>全部</option>{categories.map((name) => <option key={name}>{name}</option>)}</select>
      <label className="check-label inline-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />顯示停用品項</label>
    </div>
    {loading ? <p>載入庫存中…</p> : <div className="table-card"><table className="inventory-table"><thead><tr><th>品項</th><th>分類</th><th>目前庫存</th><th>預估使用</th><th>有效期限</th><th>狀態</th><th>操作</th></tr></thead><tbody>
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
            <button type="button" className="row-text-button" disabled={!canCount} onClick={() => onCountItem(item)} title={canCount ? undefined : "你的帳號沒有盤點權限"}><ClipboardCheck size={14} />盤點</button>
            <button type="button" className="row-text-button" disabled={!canCount} onClick={() => onAddMovement(item)} title={canCount ? undefined : "你的帳號沒有新增異動的權限"}><ClipboardList size={14} />異動</button>
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
function MovementLogView({ inventory }: { inventory: InventoryItem[] }) {
  const [movements, setMovements] = useState<StockMovementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  const [itemId, setItemId] = useState("");
  const [movementTypeLabel, setMovementTypeLabel] = useState<MovementType | "">("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const load = async () => {
        setLoading(true);
        setError("");
        try {
          const params = new URLSearchParams();
          if (itemId) params.set("itemId", itemId);
          if (movementTypeLabel) params.set("movementType", MOVEMENT_TYPE_ENUM[movementTypeLabel]);
          const response = await fetch(`/api/inventory/movements?${params.toString()}`);
          const data = await response.json() as { movements?: StockMovementRecord[]; demo?: boolean; error?: string };
          if (!response.ok) throw new Error(data.error || "讀取異動紀錄失敗");
          setMovements(data.movements || []);
          setDemo(Boolean(data.demo));
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "讀取異動紀錄失敗，請稍後再試。");
        } finally {
          setLoading(false);
        }
      };
      load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [itemId, movementTypeLabel]);

  const movementTypeOptions = Object.keys(MOVEMENT_TYPE_ENUM) as MovementType[];

  return <><PageHeader title="異動紀錄" subtitle="新增進貨單、盤點修正、新增異動，所有真正影響庫存數量的紀錄都會出現在這裡。" />
    {demo && <div className="warning-box"><span>• 尚未設定Supabase，無法顯示異動紀錄。</span></div>}
    <div className="toolbar">
      <select value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">全部品項</option>{inventory.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select value={movementTypeLabel} onChange={(e) => setMovementTypeLabel(e.target.value as MovementType | "")}><option value="">全部類型</option>{movementTypeOptions.map((t) => <option key={t}>{t}</option>)}</select>
    </div>
    {error && <div className="error-box">{error}</div>}
    {loading ? <p>載入異動紀錄中…</p> : movements.length === 0 ? <div className="report-empty-state"><AlertTriangle size={28} /><strong>沒有符合條件的異動紀錄</strong><p>請調整篩選條件，或先到「庫存管理」新增異動／盤點。</p></div> : <div className="table-card"><table><thead><tr><th>時間</th><th>品項</th><th>異動類型</th><th>數量</th><th>批次到期日</th><th>操作人</th><th>備註</th></tr></thead><tbody>{movements.map((m) => <tr key={m.id}><td>{new Date(m.createdAt).toLocaleString("zh-TW")}</td><td><strong>{m.itemName}</strong></td><td>{m.movementType}</td><td><b className={m.quantityChange > 0 ? "positive-text" : "danger-text"}>{formatSignedNumber(m.quantityChange)} {m.unit}</b></td><td>{m.expiryDate || "—"}</td><td>{m.operatorName}</td><td>{m.note || "—"}</td></tr>)}</tbody></table></div>}
  </>;
}


function NotesView({ notes, loading, loadError, canManage, onNew, onDelete }: { notes: HandoverNote[]; loading: boolean; loadError: string; canManage: boolean; onNew: () => void; onDelete: (note: HandoverNote) => void }) {
  return <><PageHeader title="交接留言" subtitle="將客人需求、房務、設備與餐飲事項留在對的位置。" button="新增交接留言" onClick={onNew} />{loadError && <div className="error-box">{loadError}</div>}{loading && notes.length === 0 && <p>載入交接留言中…</p>}<div className="notes-page">{notes.map((note) => <article key={note.id}><header><Pill tone={note.important ? "red" : "sage"}>{note.category}</Pill>{note.important && <span className="important-label">重要</span>}{canManage && <button className="note-delete" aria-label="刪除留言" onClick={() => onDelete(note)}><Trash2 size={15} /></button>}</header><p>{note.content}</p><footer>{note.author}<span>{note.createdAt}</span></footer></article>)}</div></>;
}


function Status({ status }: { status: PurchaseStatus }) {
  const tone = status === "待確認" ? "red" : status === "已訂購" ? "blue" : "gold";
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

function MovementEntryModal({ item, onClose, onConfirm }: {
  item: InventoryItem;
  onClose: () => void;
  onConfirm: (movementType: string, changeAmount: number, note?: string, batch?: { batchId?: string; expiryDate?: string }) => Promise<string | void>;
}) {
  const [type, setType] = useState<MovementType>("採購入庫");
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
    <div className="stock-hint">目前庫存：{formatNumber(item.quantity)} {item.unit}</div>
    <label>異動類型<select value={type} onChange={(e) => { setType(e.target.value as MovementType); setBatchId(AUTO_BATCH); }}>{MOVEMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
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

  return <ModalShell title="刪除交接留言" subtitle="此操作無法復原" onClose={onClose}>
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
    <label>修正原因或備註（可不填）<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：季度盤點、破損報廢" /></label>
    {error && <div className="error-box">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={counts.length === 0 || submitting}>{submitting ? "儲存中…" : "確認修正庫存"}</button></div>
  </form></ModalShell>;
}

function NoteModal({ onClose, onSave }: { onClose: () => void; onSave: (n: NoteDraft) => Promise<string | void> }) {
  const [category, setCategory] = useState<HandoverNote["category"]>("房務問題"); const [content, setContent] = useState(""); const [important, setImportant] = useState(false);
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  return <ModalShell title="新增交接留言" subtitle="重要事項請開啟標記，讓下一班人員優先看到" onClose={onClose}><form onSubmit={async (e) => { e.preventDefault(); if (!content.trim()) return; setSubmitting(true); setError(""); const saveError = await onSave({ category, content: content.trim(), important }); setSubmitting(false); if (saveError) setError(saveError); }}><label>分類<select value={category} onChange={(e) => setCategory(e.target.value as HandoverNote["category"])}><option>客人需求</option><option>房務問題</option><option>設備維修</option><option>餐飲</option><option>重要公告</option></select></label><label>留言內容<textarea required value={content} onChange={(e) => setContent(e.target.value)} placeholder="請清楚寫下需要接續處理的事情" /></label><label className="check-label"><input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />標記為重要事項</label>{error && <div className="error-box">{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting}>{submitting ? "送出中…" : "新增留言"}</button></div></form></ModalShell>;
}
