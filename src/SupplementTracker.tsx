import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  Plus, Trash2, Download, Upload, Save, TrendingUp, Check, AlertCircle, Pencil, Link2, ExternalLink, Tags, RefreshCw, Settings, X,
} from "lucide-react";

const STORAGE_KEY = "rakuten-supp-tracker-v3";

// ---- 楽天市場 商品検索API（RMS OpenAPI版）----
// dev: Viteプロキシ経由（Originを登録ドメインに偽装／CORS回避）。本番: ブラウザから直叩き（登録ドメイン上で実Originが飛ぶ）。
const RAKUTEN_API_PATH = "/ichibams/api/IchibaItem/Search/20260401";
const RAKUTEN_BASE = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV)
  ? "/rk-proxy"                              // → vite.config.js のプロキシへ
  : "https://openapi.rakuten.co.jp";          // 本番は直接
const ENV = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1商品ぶんの最新値を取得。itemCode優先、keyword + shopCode で検索（2026-04-01 API版）。
async function fetchRakutenItem(product, appId, accessKey, attempt = 1) {
  const params = new URLSearchParams({ format: "json", formatVersion: "2", applicationId: appId, accessKey });
  if (product.itemCode) {
    params.set("itemCode", product.itemCode);        // itemCodeの時は hits を付けない
  } else {
    params.set("hits", "3");
    params.set("keyword", product.keyword || product.name);
    if (product.shopCode) params.set("shopCode", product.shopCode);
  }
  const res = await fetch(`${RAKUTEN_BASE}${RAKUTEN_API_PATH}?${params.toString()}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if ((!res.ok || !json) && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchRakutenItem(product, appId, accessKey, attempt + 1);
  }
  if (json && (json.error || json.errors)) {
    throw new Error(json.error_description || json.errors?.errorMessage || json.error || `HTTP ${res.status}`);
  }
  const raw = json?.Items?.[0];
  const item = raw ? (raw.Item || raw) : null;
  if (!item) throw new Error("該当商品が見つかりません");
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return { reviews: num(item.reviewCount), price: num(item.itemPrice), name: item.itemName, url: item.itemUrl, itemCode: item.itemCode };
}

// 楽天商品ランキングを取得（genreIdベース）
async function fetchRanking(genreId, appId, accessKey) {
  const RANKING_BASE = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601";
  const rankingMap = {}; // { itemCode: rank }
  
  // page 1-4 をページング（1ページ約30件）
  for (let page = 1; page <= 4; page++) {
    const params = new URLSearchParams({ 
      format: "json", 
      formatVersion: "2",
      applicationId: appId, 
      accessKey, 
      genreId,
      page: page.toString()
    });
    
    try {
      const res = await fetch(`${RANKING_BASE}?${params.toString()}`);
      
      if (!res.ok) {
        console.warn(`🐛 ランキングAPI page ${page} 失敗:`, res.status);
        continue;
      }
      
      const json = await res.json();
      
      // エラーチェック
      if (json.error) {
        console.warn(`🐛 ランキングAPI page ${page} エラー:`, json.error, json.error_description);
        continue;
      }
      
      // items配列からitemCodeとrankを抽出
      if (json.items && Array.isArray(json.items)) {
        console.log(`🔍 ランキング page ${page}: ${json.items.length}件取得`);
        
        for (const item of json.items) {
          if (item.itemCode && item.rank) {
            rankingMap[item.itemCode] = item.rank;
          }
        }
      } else {
        console.warn(`🐛 ランキング page ${page} items配列がありません`);
      }
      
      // 次のページの前に1.5秒待機（レート制限対策）
      if (page < 4) {
        await sleep(1500);
      }
      
    } catch (error) {
      console.warn(`🐛 ランキングAPI page ${page} 例外:`, error.message);
    }
  }
  
  console.log(`📊 ランキング取得完了: ${Object.keys(rankingMap).length}件`);
  return rankingMap;
}

const EQUOL_COLORS = ["#534AB7", "#7F77DD", "#26215C", "#9F8BEE"];
const KALIUM_COLORS = ["#0F6E56", "#1D9E75", "#04342C", "#5DCAA5"];
const SITE_COLORS = ["#534AB7", "#0F6E56", "#D85A30", "#185FA5", "#993556"];

// キーワードの分類（タイトル内で果たす役割）と表示色
const KW_TYPES = {
  成分: { color: "#0F6E56", bg: "#E1F5EE", desc: "主成分・配合成分" },
  規格: { color: "#185FA5", bg: "#E2EEFA", desc: "粒数・容量・配合量・期間" },
  訴求: { color: "#C2541F", bg: "#FBEBDF", desc: "ベネフィット・悩み・特典" },
  信頼: { color: "#534AB7", bg: "#EEEDFE", desc: "正規品・公式・専門性" },
  実績: { color: "#993556", bg: "#F7E6EC", desc: "ランキング・受賞・売上" },
  対象: { color: "#7A5A1E", bg: "#F4ECDA", desc: "ターゲット層" },
  ブランド: { color: "#5F5E5A", bg: "#EFEDE8", desc: "指名・ブランド名" },
};

// 楽天 上位商品タイトルから抽出した「効いている」キーワード候補。
// count = サンプルした上位商品タイトルのうち、その語（表記ゆれ含む）を含む商品数。
// 検索ボリュームではなく「上位商品が実際にタイトルへ入れている＝有効と判断している語」の出現頻度。
const KEYWORDS = {
  meta: {
    sampledAt: todayStrSafe(),
    note: "楽天の検索上位・ランキング掲載の実在商品タイトルから抽出。数値は検索数ではなく上位商品タイトル中の出現数。",
  },
  エクオール: {
    sample: 7,
    terms: [
      { word: "エクオール", count: 7, type: "成分" },
      { word: "約1ヶ月分 / 30日分（期間表記）", count: 4, type: "規格" },
      { word: "大豆イソフラボン / イソフラボン", count: 3, type: "成分" },
      { word: "サプリ / サプリメント", count: 3, type: "訴求" },
      { word: "送料無料", count: 2, type: "訴求" },
      { word: "10mg配合（含有量）", count: 2, type: "規格" },
      { word: "1カプセル / 1粒", count: 2, type: "規格" },
      { word: "120粒", count: 2, type: "規格" },
      { word: "正規品 / 正規取扱店", count: 2, type: "信頼" },
      { word: "薬局 / 調剤薬局", count: 2, type: "信頼" },
      { word: "大塚製薬 / エクエル（指名）", count: 2, type: "ブランド" },
      { word: "シードコムス（指名）", count: 2, type: "ブランド" },
      { word: "パウチ（形状）", count: 2, type: "規格" },
      { word: "栄養機能食品", count: 1, type: "信頼" },
      { word: "国内製造", count: 1, type: "信頼" },
      { word: "更年期 / ゆらぎ", count: 1, type: "訴求" },
      { word: "フェムケア", count: 1, type: "訴求" },
      { word: "女性", count: 1, type: "対象" },
      { word: "美容 / 健康", count: 1, type: "訴求" },
    ],
  },
  カリウム: {
    sample: 6,
    terms: [
      { word: "カリウム", count: 6, type: "成分" },
      { word: "塩化カリウム", count: 6, type: "成分" },
      { word: "サプリ / サプリメント", count: 6, type: "訴求" },
      { word: "日本製 / 国内製造", count: 5, type: "信頼" },
      { word: "含有量mgアピール（1,125〜75,000mg）", count: 5, type: "規格" },
      { word: "送料無料", count: 4, type: "訴求" },
      { word: "300粒", count: 4, type: "規格" },
      { word: "60日分 / 約2ヶ月分（期間表記）", count: 4, type: "規格" },
      { word: "ビタミンB / B6 / B1", count: 4, type: "成分" },
      { word: "公式", count: 3, type: "信頼" },
      { word: "栄養機能食品 / 栄養補助食品", count: 3, type: "信頼" },
      { word: "黒しょうが / ブラックジンジャー", count: 3, type: "成分" },
      { word: "必須ミネラル / ミネラル", count: 3, type: "訴求" },
      { word: "管理栄養士推奨", count: 2, type: "信頼" },
      { word: "楽天1位", count: 2, type: "実績" },
      { word: "モンドセレクション金賞", count: 2, type: "実績" },
      { word: "売上世界No.1", count: 2, type: "実績" },
      { word: "ポリフェノール", count: 2, type: "成分" },
      { word: "大容量", count: 2, type: "訴求" },
      { word: "美容 / 健康", count: 2, type: "訴求" },
      { word: "270粒", count: 2, type: "規格" },
      { word: "ヒハツ / ショウガ", count: 1, type: "成分" },
      { word: "むくみ / 美脚 / ふくらはぎ", count: 1, type: "訴求" },
      { word: "産後 / 妊婦", count: 1, type: "対象" },
    ],
  },
};

const todayStr = () => new Date().toISOString().slice(0, 10);
function todayStrSafe() { return new Date().toISOString().slice(0, 10); }

const SEED = {
  products: [
    { id: "p1", name: "エクオール 1ヶ月分（10mg）", category: "エクオール", store: "サプリ専門SHOP シードコムス", shopCode: "seedcoms", keyword: "エクオール", itemCode: "seedcoms:10007542" },
    { id: "p2", name: "大塚製薬 エクエル パウチ 3袋セット", category: "エクオール", store: "市民薬局 楽天市場店", shopCode: "shimin2", keyword: "エクエル パウチ 3袋", itemCode: "shimin2:10000782" },
    { id: "p3", name: "大塚製薬 エクエル パウチ 単品", category: "エクオール", store: "市民薬局 楽天市場店", shopCode: "shimin2", keyword: "エクエル パウチ", itemCode: "shimin2:10000777" },
    { id: "p4", name: "カリウムの力 270粒", category: "カリウム", store: "ウェルモット公式ショップ（旧 TFCO）", shopCode: "is-near", keyword: "カリウムの力 270粒" },
    { id: "p5", name: "メグリウム 塩化カリウム1300mg", category: "カリウム", store: "slife（メグリウム）", shopCode: "aequalis", keyword: "メグリウム", itemCode: "slife:10362528" },
    { id: "p6", name: "カリウム習慣 300粒", category: "カリウム", store: "ライフナビ（RoyalBS）", shopCode: "life-navi", keyword: "カリウム習慣 300粒", itemCode: "jnl:10993203" },
  ],
  logs: {
    p1: { [todayStr()]: { reviews: 7206, rank: null, price: 2980 } },
    p2: { [todayStr()]: { reviews: 6424, rank: null, price: 11212 } },
    p3: { [todayStr()]: { reviews: 3664, rank: null, price: 3852 } },
    // 以下は楽天上位ページ／検索からの概算スナップショット（2026-06-12 時点・要実測上書き）
    p4: { [todayStr()]: { reviews: 2741, rank: null, price: 1700 } },
    p5: { [todayStr()]: { reviews: null, rank: null, price: 1480 } },
    p6: { [todayStr()]: { reviews: null, rank: null, price: 1680 } },
  },
  sites: [
    { id: "s1", name: "サプリ専門SHOP シードコムス", domain: "" },
    { id: "s2", name: "市民薬局 楽天市場店", domain: "" },
    { id: "s3", name: "カリウムの力 公式（TFCO）", domain: "" },
    { id: "s4", name: "RoyalBS 公式", domain: "" },
    { id: "s5", name: "メグリウム 楽天市場店", domain: "" },
  ],
  backlinks: {},
  keywords: KEYWORDS,
};

function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
const monthKey = (dateStr) => dateStr.slice(0, 7);

const METRICS = {
  reviews: { label: "レビュー数", unit: "件", betterHigh: true },
  rank: { label: "ランキング順位", unit: "位", betterHigh: false },
  price: { label: "価格", unit: "円", betterHigh: false },
};

const colorFor = (products, id) => {
  const p = products.find((x) => x.id === id);
  if (!p) return "#888780";
  const list = p.category === "エクオール" ? EQUOL_COLORS : KALIUM_COLORS;
  const idx = products.filter((x) => x.category === p.category).findIndex((x) => x.id === id);
  return list[idx % list.length];
};

async function loadData() {
  try {
    if (typeof window !== "undefined" && window.storage) {
      const r = await window.storage.get(STORAGE_KEY);
      if (r && r.value) return JSON.parse(r.value);
    }
  } catch (e) {}
  return null;
}
async function persist(data) {
  try {
    if (typeof window !== "undefined" && window.storage) {
      await window.storage.set(STORAGE_KEY, JSON.stringify(data));
      return true;
    }
  } catch (e) {}
  return false;
}

const border = "0.5px solid rgba(120,120,120,0.2)";
const inputStyle = { fontSize: 13, padding: "7px 9px", borderRadius: 6, border: "0.5px solid rgba(120,120,120,0.3)" };

export default function SupplementTracker() {
  const [data, setData] = useState(SEED);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState("tracker");
  const [view, setView] = useState("daily");
  const [metric, setMetric] = useState("reviews");
  const [cat, setCat] = useState("すべて");
  const [entryDate, setEntryDate] = useState(todayStr());
  const [draft, setDraft] = useState({});
  const [saved, setSaved] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newP, setNewP] = useState({ name: "", category: "エクオール", store: "", itemCode: "" });

  // 楽天API取得まわり
  const [appId, setAppId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [showApiCfg, setShowApiCfg] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchLog, setFetchLog] = useState(null);

  useEffect(() => {
    try {
      setAppId(localStorage.getItem("rk_app_id") || ENV.VITE_RAKUTEN_APP_ID || "");
      setAccessKey(localStorage.getItem("rk_access_key") || ENV.VITE_RAKUTEN_ACCESS_KEY || "");
    } catch {}
  }, []);
  const saveCreds = (id, key) => {
    try { localStorage.setItem("rk_app_id", id); localStorage.setItem("rk_access_key", key); } catch {}
  };

  const fetchFromRakuten = async () => {
    if (!appId.trim() || !accessKey.trim()) { setShowApiCfg(true); flash("APIキーを設定してください"); return; }
    setFetching(true); setFetchLog(null);

    // ① ジャンル別ランキングを取得（itemCode → 順位 のマップ）
    const GENRE = { "エクオール": "567631", "カリウム": "214787" };
    const rankingByCat = {};
    for (const [cat, gid] of Object.entries(GENRE)) {
      try { rankingByCat[cat] = await fetchRanking(gid, appId.trim(), accessKey.trim()); }
      catch (e) { rankingByCat[cat] = {}; }
      await sleep(1500);
    }

    // ② 各商品を取得し、順位を照合
    const logs = { ...data.logs };
    const results = [];
    for (const p of data.products) {
      try {
        const r = await fetchRakutenItem(p, appId.trim(), accessKey.trim());
        const rankMap = rankingByCat[p.category] || {};
        const rank = (r.itemCode && rankMap[r.itemCode] != null) ? rankMap[r.itemCode] : null;
        const entry = { reviews: r.reviews, rank, price: r.price };
        logs[p.id] = { ...(logs[p.id] || {}), [entryDate]: entry };
        results.push({ name: p.name, ok: true, reviews: r.reviews, price: r.price, rank });
      } catch (e) {
        results.push({ name: p.name, ok: false, err: String(e.message || e) });
      }
      await sleep(1200);
    }

    const okCount = results.filter((r) => r.ok).length;
    if (okCount > 0) await commit({ ...data, logs }, `楽天から${okCount}件を取得・記録しました`);
    else flash("取得に失敗しました（下の結果を確認）");
    setFetchLog(results);
    setFetching(false);
  };

  const [selectedSite, setSelectedSite] = useState("s1");
  const [newSite, setNewSite] = useState("");
  const [blDraft, setBlDraft] = useState({ source: "", url: "", anchor: "", dr: "", type: "follow", date: todayStr() });

  useEffect(() => {
    (async () => {
      const d = await loadData();
      if (d && d.products) {
        setData({
          products: d.products || SEED.products,
          logs: d.logs || {},
          sites: d.sites || SEED.sites,
          backlinks: d.backlinks || {},
          keywords: d.keywords || SEED.keywords,
        });
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (data.sites?.length && !data.sites.find((s) => s.id === selectedSite)) {
      setSelectedSite(data.sites[0].id);
    }
  }, [data.sites]);

  useEffect(() => {
    const next = {};
    data.products.forEach((p) => {
      const l = data.logs[p.id]?.[entryDate];
      next[p.id] = { reviews: l?.reviews ?? "", rank: l?.rank ?? "", price: l?.price ?? "" };
    });
    setDraft(next);
  }, [entryDate, data]);

  const flash = (msg) => { setSaved(msg); setTimeout(() => setSaved(""), 2200); };

  const commit = useCallback(async (next, msg) => {
    setData(next);
    const ok = await persist(next);
    flash(ok ? (msg || "保存しました") : "メモリに保存（このタブのみ）");
  }, []);

  const saveEntry = async () => {
    const logs = { ...data.logs };
    data.products.forEach((p) => {
      const d = draft[p.id] || {};
      const entry = {
        reviews: d.reviews === "" ? null : Number(d.reviews),
        rank: d.rank === "" ? null : Number(d.rank),
        price: d.price === "" ? null : Number(d.price),
      };
      const hasAny = entry.reviews != null || entry.rank != null || entry.price != null;
      if (hasAny) logs[p.id] = { ...(logs[p.id] || {}), [entryDate]: entry };
      else if (logs[p.id]?.[entryDate]) {
        const cp = { ...logs[p.id] }; delete cp[entryDate]; logs[p.id] = cp;
      }
    });
    await commit({ ...data, logs }, `${entryDate} の数値を記録しました`);
  };

  const addProduct = async () => {
    if (!newP.name.trim()) return;
    const id = "u" + Date.now();
    const next = { ...data, products: [...data.products, { id, ...newP, name: newP.name.trim(), store: newP.store.trim(), itemCode: (newP.itemCode || "").trim() }] };
    setNewP({ name: "", category: "エクオール", store: "", itemCode: "" });
    setShowAdd(false);
    await commit(next, "商品を追加しました");
  };

  const removeProduct = async (id) => {
    const logs = { ...data.logs }; delete logs[id];
    await commit({ ...data, products: data.products.filter((p) => p.id !== id), logs }, "商品を削除しました");
  };

  // ---- backlink handlers ----
  const addSite = async () => {
    if (!newSite.trim()) return;
    const id = "site" + Date.now();
    const next = { ...data, sites: [...data.sites, { id, name: newSite.trim(), domain: "" }] };
    setNewSite("");
    setSelectedSite(id);
    await commit(next, "店舗を追加しました");
  };
  const removeSite = async (id) => {
    const bl = { ...data.backlinks }; delete bl[id];
    await commit({ ...data, sites: data.sites.filter((s) => s.id !== id), backlinks: bl }, "店舗を削除しました");
  };
  const setDomain = async (id, domain) => {
    const next = { ...data, sites: data.sites.map((s) => (s.id === id ? { ...s, domain } : s)) };
    await commit(next, "ドメインを更新しました");
  };
  const addBacklink = async () => {
    if (!selectedSite || !blDraft.source.trim()) return;
    const bl = {
      id: "b" + Date.now(),
      source: blDraft.source.trim(), url: blDraft.url.trim(), anchor: blDraft.anchor.trim(),
      dr: blDraft.dr === "" ? null : Number(blDraft.dr), type: blDraft.type, date: blDraft.date,
    };
    const next = { ...data, backlinks: { ...data.backlinks, [selectedSite]: [...(data.backlinks[selectedSite] || []), bl] } };
    setBlDraft({ source: "", url: "", anchor: "", dr: "", type: "follow", date: todayStr() });
    await commit(next, "被リンクを追加しました");
  };
  const removeBacklink = async (siteId, blId) => {
    const next = { ...data, backlinks: { ...data.backlinks, [siteId]: (data.backlinks[siteId] || []).filter((b) => b.id !== blId) } };
    await commit(next, "被リンクを削除しました");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `rakuten-supp-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const exportKeywordsCsv = () => {
    const rows = [["カテゴリ", "キーワード候補", "上位タイトル出現数", "サンプル商品数", "分類"]];
    Object.entries(data.keywords || {}).filter(([k]) => k !== "meta").forEach(([cat, cd]) => {
      (cd.terms || []).forEach((t) => rows.push([cat, t.word, t.count, cd.sample, t.type]));
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `rakuten-keywords-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try { const p = JSON.parse(reader.result); if (p.products) await commit({ products: p.products, logs: p.logs || {}, sites: p.sites || SEED.sites, backlinks: p.backlinks || {}, keywords: p.keywords || SEED.keywords }, "読み込みました"); }
      catch (err) { flash("読み込みに失敗しました"); }
    };
    reader.readAsText(file); e.target.value = "";
  };

  const visible = useMemo(() => data.products.filter((p) => cat === "すべて" || p.category === cat), [data.products, cat]);

  const chart = useMemo(() => {
    const periodOf = (date) => (view === "daily" ? date : view === "weekly" ? getWeekStart(date) : monthKey(date));
    const periodSet = new Set();
    visible.forEach((p) => Object.keys(data.logs[p.id] || {}).forEach((d) => periodSet.add(periodOf(d))));
    const periods = [...periodSet].sort();
    const valueForPeriod = (pid, period) => {
      const logs = data.logs[pid] || {};
      const dates = Object.keys(logs).filter((d) => periodOf(d) === period).sort();
      for (let i = dates.length - 1; i >= 0; i--) { const v = logs[dates[i]][metric]; if (v != null) return v; }
      return null;
    };
    return periods.map((period) => {
      const row = { period };
      visible.forEach((p) => { row[p.id] = valueForPeriod(p.id, period); });
      return row;
    });
  }, [visible, data.logs, view, metric]);

  const labelFor = (period) => {
    if (view === "daily") return period.slice(5).replace("-", "/");
    if (view === "weekly") return period.slice(5).replace("-", "/") + "〜";
    return period;
  };

  const summary = useMemo(() => visible.map((p) => {
    const series = chart.map((r) => r[p.id]).filter((v) => v != null);
    const latest = series.length ? series[series.length - 1] : null;
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const delta = latest != null && prev != null ? latest - prev : null;
    return { p, latest, delta };
  }), [visible, chart]);

  const hasData = chart.some((r) => visible.some((p) => r[p.id] != null));

  if (!loaded) return <div style={{ padding: 40, textAlign: "center", fontSize: 13, color: "#888780" }}>読み込み中…</div>;

  const tab = (active, accent = "#534AB7", bg = "#EEEDFE", txt = "#26215C") => ({
    padding: "7px 14px", fontSize: 14, borderRadius: 8, cursor: "pointer",
    border: "0.5px solid " + (active ? accent : "rgba(120,120,120,0.25)"),
    background: active ? bg : "#fff", color: active ? txt : "#444441", fontWeight: active ? 500 : 400,
  });

  const siteColor = (id) => SITE_COLORS[data.sites.findIndex((s) => s.id === id) % SITE_COLORS.length];

  // ---- backlink derived ----
  const curBL = data.backlinks[selectedSite] || [];
  const curSite = data.sites.find((s) => s.id === selectedSite);
  const blFollow = curBL.filter((b) => b.type === "follow").length;
  const drVals = curBL.map((b) => b.dr).filter((v) => v != null);
  const avgDr = drVals.length ? Math.round(drVals.reduce((a, b) => a + b, 0) / drVals.length) : null;
  const blCompare = data.sites.map((s) => ({ name: s.name, count: (data.backlinks[s.id] || []).length, id: s.id }));

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif", color: "#2C2C2A" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>サプリ販売トラッカー</h1>
        <span style={{ fontSize: 13, color: "#5F5E5A" }}>エクオール・カリウム</span>
      </div>

      {/* top mode nav */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18, borderBottom: border, paddingBottom: 14 }}>
        <button onClick={() => setMode("tracker")} style={{ ...tab(mode === "tracker"), display: "flex", alignItems: "center", gap: 6 }}><TrendingUp size={15} /> 販売トラッカー</button>
        <button onClick={() => setMode("backlinks")} style={{ ...tab(mode === "backlinks", "#0F6E56", "#E1F5EE", "#085041"), display: "flex", alignItems: "center", gap: 6 }}><Link2 size={15} /> 被リンク管理</button>
        <button onClick={() => setMode("keywords")} style={{ ...tab(mode === "keywords", "#C2541F", "#FBEBDF", "#8A3A14"), display: "flex", alignItems: "center", gap: 6 }}><Tags size={15} /> キーワード分析</button>
      </div>

      {mode === "tracker" && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 6 }}>
              {[["daily", "日別"], ["weekly", "週別"], ["monthly", "月別"]].map(([v, l]) => (
                <button key={v} onClick={() => setView(v)} style={tab(view === v)}>{l}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {Object.entries(METRICS).map(([k, m]) => (<button key={k} onClick={() => setMetric(k)} style={tab(metric === k)}>{m.label}</button>))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {["すべて", "エクオール", "カリウム"].map((c) => (<button key={c} onClick={() => setCat(c)} style={tab(cat === c)}>{c}</button>))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
            {summary.map(({ p, latest, delta }) => (
              <div key={p.id} style={{ background: "#fff", border, borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: colorFor(data.products, p.id), flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: "#5F5E5A", lineHeight: 1.3 }}>{p.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 22, fontWeight: 500 }}>{latest != null ? latest.toLocaleString() : "—"}</span>
                  <span style={{ fontSize: 12, color: "#888780" }}>{METRICS[metric].unit}</span>
                  {delta != null && delta !== 0 && (
                    <span style={{ fontSize: 12, fontWeight: 500, color: (delta > 0) === METRICS[metric].betterHigh ? "#0F6E56" : "#A32D2D" }}>{delta > 0 ? "+" : ""}{delta.toLocaleString()}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{ background: "#fff", border, borderRadius: 12, padding: "16px 12px 8px", marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px 8px", fontSize: 13, color: "#5F5E5A" }}>
              <TrendingUp size={15} /> {METRICS[metric].label}の推移（{{ daily: "日別", weekly: "週別", monthly: "月別" }[view]}）
            </div>
            {hasData ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="rgba(120,120,120,0.12)" vertical={false} />
                  <XAxis dataKey="period" tickFormatter={labelFor} tick={{ fontSize: 11, fill: "#888780" }} />
                  <YAxis reversed={metric === "rank"} tick={{ fontSize: 11, fill: "#888780" }} width={48} tickFormatter={(v) => v.toLocaleString()} domain={metric === "rank" ? [1, "auto"] : ["auto", "auto"]} />
                  <Tooltip labelFormatter={labelFor} formatter={(v, name) => { const p = data.products.find((x) => x.id === name); return [v != null ? v.toLocaleString() + METRICS[metric].unit : "—", p ? p.name : name]; }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "0.5px solid rgba(120,120,120,0.3)" }} />
                  {visible.map((p) => (<Line key={p.id} type="monotone" dataKey={p.id} stroke={colorFor(data.products, p.id)} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "48px 16px", color: "#888780" }}>
                <AlertCircle size={20} /><span style={{ fontSize: 14 }}>まだデータがありません。下のフォームで今日の数値を入力してください。</span>
              </div>
            )}
          </div>

          {/* 楽天から自動取得 */}
          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <RefreshCw size={15} style={{ color: "#0F6E56" }} />
                <span style={{ fontSize: 15, fontWeight: 500 }}>楽天から自動取得</span>
                <span style={{ fontSize: 12, color: "#888780" }}>商品検索APIで{entryDate}のレビュー数・価格を記録</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => setShowApiCfg((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", fontSize: 13, background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer", color: "#444441" }}><Settings size={14} /> キー設定</button>
                <button onClick={fetchFromRakuten} disabled={fetching} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", fontSize: 14, fontWeight: 500, color: "#fff", background: fetching ? "#7FB3A2" : "#0F6E56", border: "none", borderRadius: 8, cursor: fetching ? "default" : "pointer" }}>
                  <RefreshCw size={15} style={fetching ? { animation: "spin 1s linear infinite" } : undefined} /> {fetching ? "取得中…" : "取得して記録"}
                </button>
              </div>
            </div>

            {showApiCfg && (
              <div style={{ marginTop: 12, padding: 12, background: "#F7F6F2", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input placeholder="Application ID" value={appId} onChange={(e) => { setAppId(e.target.value); saveCreds(e.target.value, accessKey); }} style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
                  <input type="password" placeholder="accessKey（pk_…）" value={accessKey} onChange={(e) => { setAccessKey(e.target.value); saveCreds(appId, e.target.value); }} style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
                </div>
                <div style={{ fontSize: 11.5, color: "#888780", marginTop: 8, lineHeight: 1.7 }}>
                  キーはこのブラウザのみに保存（書き出しJSONには含めません）。<br />
                  この <code>pk_</code> キーは<strong>リファラ制限付き</strong>です。<strong>本番</strong>＝登録ドメイン上のブラウザから直接動作。<strong>ローカル開発</strong>＝<code>.env.local</code> の <code>VITE_RAKUTEN_REFERER</code> に登録済みドメインを設定し、Viteプロキシ経由で動作します（未設定だと403 NOT_ALLOWED）。
                </div>
              </div>
            )}

            {fetchLog && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {fetchLog.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 8px", borderRadius: 6, background: r.ok ? "#E9F6F1" : "#FBEBEB" }}>
                    {r.ok ? <Check size={13} style={{ color: "#0F6E56", flexShrink: 0 }} /> : <X size={13} style={{ color: "#A32D2D", flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, color: "#444441" }}>{r.name}</span>
                    {r.ok
                      ? <span style={{ color: "#5F5E5A" }}>レビュー {r.reviews?.toLocaleString() ?? "—"} / ¥{r.price?.toLocaleString() ?? "—"}</span>
                      : <span style={{ color: "#A32D2D" }}>{r.err}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Pencil size={15} style={{ color: "#534AB7" }} />
                <span style={{ fontSize: 15, fontWeight: 500 }}>数値を記録</span>
                <input type="date" value={entryDate} max={todayStr()} onChange={(e) => setEntryDate(e.target.value)} style={{ ...inputStyle, padding: "6px 8px" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {saved && (<span style={{ fontSize: 12, color: "#0F6E56", display: "flex", alignItems: "center", gap: 4 }}><Check size={13} /> {saved}</span>)}
                <button onClick={saveEntry} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", fontSize: 14, fontWeight: 500, color: "#fff", background: "#534AB7", border: "none", borderRadius: 8, cursor: "pointer" }}><Save size={15} /> 記録する</button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 560 }}>
                <thead>
                  <tr style={{ color: "#888780", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px", fontWeight: 400 }}>商品</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 110 }}>レビュー数</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 90 }}>順位</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 110 }}>価格(円)</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.id} style={{ borderTop: "0.5px solid rgba(120,120,120,0.15)" }}>
                      <td style={{ padding: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ width: 9, height: 9, borderRadius: 3, background: colorFor(data.products, p.id), flexShrink: 0 }} />
                          <div><div style={{ lineHeight: 1.3 }}>{p.name}</div><div style={{ fontSize: 11, color: "#888780" }}>{p.store}</div></div>
                        </div>
                      </td>
                      {["reviews", "rank", "price"].map((f) => (
                        <td key={f} style={{ padding: "6px 8px" }}>
                          <input type="number" value={draft[p.id]?.[f] ?? ""} onChange={(e) => setDraft({ ...draft, [p.id]: { ...draft[p.id], [f]: e.target.value } })} placeholder="—" style={{ ...inputStyle, width: "100%", padding: "6px 8px", borderRadius: 6 }} />
                        </td>
                      ))}
                      <td style={{ textAlign: "center" }}>
                        {p.id.startsWith("u") && (<button onClick={() => removeProduct(p.id)} title="削除" style={{ background: "none", border: "none", cursor: "pointer", color: "#A32D2D", padding: 4 }}><Trash2 size={15} /></button>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showAdd ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 12, padding: 12, background: "#F7F6F2", borderRadius: 8 }}>
                <input placeholder="商品名" value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} style={{ ...inputStyle, flex: 2, minWidth: 160 }} />
                <input placeholder="店舗名" value={newP.store} onChange={(e) => setNewP({ ...newP, store: e.target.value })} style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
                <input placeholder="itemCode（任意 例 shop:123）" value={newP.itemCode} onChange={(e) => setNewP({ ...newP, itemCode: e.target.value })} style={{ ...inputStyle, flex: 1, minWidth: 140 }} />
                <select value={newP.category} onChange={(e) => setNewP({ ...newP, category: e.target.value })} style={inputStyle}><option>エクオール</option><option>カリウム</option></select>
                <button onClick={addProduct} style={{ padding: "7px 14px", fontSize: 13, fontWeight: 500, color: "#fff", background: "#0F6E56", border: "none", borderRadius: 6, cursor: "pointer" }}>追加</button>
                <button onClick={() => setShowAdd(false)} style={{ padding: "7px 12px", fontSize: 13, background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 6, cursor: "pointer" }}>取消</button>
              </div>
            ) : (
              <button onClick={() => setShowAdd(true)} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, padding: "8px 12px", fontSize: 13, background: "none", border: "0.5px dashed rgba(120,120,120,0.4)", borderRadius: 8, cursor: "pointer", color: "#444441" }}><Plus size={15} /> 追跡する商品を追加</button>
            )}
          </div>
        </>
      )}

      {mode === "backlinks" && (
        <>
          <p style={{ fontSize: 13, color: "#5F5E5A", margin: "0 0 16px" }}>
            Ahrefs / SEMrush / Majestic などで取得した各店舗の被リンクを記録します。店舗を選び、上位10件を貼り付けてください。
          </p>

          {/* compare bar */}
          <div style={{ background: "#fff", border, borderRadius: 12, padding: "14px 12px 6px", marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: "#5F5E5A", padding: "0 6px 6px" }}>店舗別 被リンク登録数</div>
            <ResponsiveContainer width="100%" height={Math.max(120, data.sites.length * 38 + 30)}>
              <BarChart data={blCompare} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="rgba(120,120,120,0.12)" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#888780" }} />
                <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: "#5F5E5A" }} />
                <Tooltip formatter={(v) => [v + " 件", "被リンク"]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "0.5px solid rgba(120,120,120,0.3)" }} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={18}>
                  {blCompare.map((s) => (<Cell key={s.id} fill={siteColor(s.id)} />))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,2.1fr)", gap: 14 }}>
            {/* site list */}
            <div style={{ background: "#fff", border, borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>店舗</div>
              {data.sites.map((s) => {
                const count = (data.backlinks[s.id] || []).length;
                const active = s.id === selectedSite;
                return (
                  <div key={s.id} onClick={() => setSelectedSite(s.id)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8, cursor: "pointer", marginBottom: 4, background: active ? "#E1F5EE" : "transparent", border: active ? "0.5px solid #1D9E75" : "0.5px solid transparent" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: siteColor(s.id), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 13, lineHeight: 1.3, color: active ? "#085041" : "#2C2C2A" }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: "#888780" }}>{count}/10</span>
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input placeholder="店舗を追加" value={newSite} onChange={(e) => setNewSite(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSite()} style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
                <button onClick={addSite} style={{ padding: "7px 10px", fontSize: 13, color: "#fff", background: "#0F6E56", border: "none", borderRadius: 6, cursor: "pointer" }}><Plus size={14} /></button>
              </div>
            </div>

            {/* detail */}
            <div style={{ background: "#fff", border, borderRadius: 12, padding: 14 }}>
              {curSite ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                    <div style={{ fontSize: 15, fontWeight: 500 }}>{curSite.name}</div>
                    {curSite.id.startsWith("site") && (<button onClick={() => removeSite(curSite.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#A32D2D" }}><Trash2 size={15} /></button>)}
                  </div>
                  <input key={curSite.id} defaultValue={curSite.domain} placeholder="分析対象ドメイン（例: example.com）" onBlur={(e) => e.target.value !== curSite.domain && setDomain(curSite.id, e.target.value.trim())} style={{ ...inputStyle, width: "100%", marginBottom: 12 }} />

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
                    {[["被リンク数", curBL.length], ["follow", blFollow], ["平均DR", avgDr ?? "—"]].map(([l, v]) => (
                      <div key={l} style={{ background: "#F1F4F0", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontSize: 11, color: "#5F5E5A" }}>{l}</div>
                        <div style={{ fontSize: 20, fontWeight: 500 }}>{typeof v === "number" ? v.toLocaleString() : v}</div>
                      </div>
                    ))}
                  </div>

                  {/* add backlink */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, padding: 10, background: "#F7F6F2", borderRadius: 8 }}>
                    <input placeholder="参照元ドメイン" value={blDraft.source} onChange={(e) => setBlDraft({ ...blDraft, source: e.target.value })} style={{ ...inputStyle, flex: 2, minWidth: 130 }} />
                    <input placeholder="リンク先URL（任意）" value={blDraft.url} onChange={(e) => setBlDraft({ ...blDraft, url: e.target.value })} style={{ ...inputStyle, flex: 2, minWidth: 130 }} />
                    <input placeholder="アンカー" value={blDraft.anchor} onChange={(e) => setBlDraft({ ...blDraft, anchor: e.target.value })} style={{ ...inputStyle, flex: 1, minWidth: 90 }} />
                    <input type="number" placeholder="DR" value={blDraft.dr} onChange={(e) => setBlDraft({ ...blDraft, dr: e.target.value })} style={{ ...inputStyle, width: 60 }} />
                    <select value={blDraft.type} onChange={(e) => setBlDraft({ ...blDraft, type: e.target.value })} style={inputStyle}><option value="follow">follow</option><option value="nofollow">nofollow</option></select>
                    <button onClick={addBacklink} style={{ padding: "7px 14px", fontSize: 13, fontWeight: 500, color: "#fff", background: "#0F6E56", border: "none", borderRadius: 6, cursor: "pointer" }}>追加</button>
                  </div>

                  {curBL.length ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 460 }}>
                        <thead>
                          <tr style={{ color: "#888780", textAlign: "left" }}>
                            <th style={{ padding: "6px 8px", fontWeight: 400 }}>参照元</th>
                            <th style={{ padding: "6px 8px", fontWeight: 400 }}>アンカー</th>
                            <th style={{ padding: "6px 8px", fontWeight: 400, width: 50 }}>DR</th>
                            <th style={{ padding: "6px 8px", fontWeight: 400, width: 78 }}>種別</th>
                            <th style={{ width: 32 }} />
                          </tr>
                        </thead>
                        <tbody>
                          {curBL.map((b) => (
                            <tr key={b.id} style={{ borderTop: "0.5px solid rgba(120,120,120,0.15)" }}>
                              <td style={{ padding: "7px 8px" }}>
                                {b.url ? (
                                  <a href={b.url} target="_blank" rel="noreferrer" style={{ color: "#185FA5", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>{b.source} <ExternalLink size={11} /></a>
                                ) : b.source}
                              </td>
                              <td style={{ padding: "7px 8px", color: "#5F5E5A" }}>{b.anchor || "—"}</td>
                              <td style={{ padding: "7px 8px" }}>{b.dr ?? "—"}</td>
                              <td style={{ padding: "7px 8px" }}>
                                <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: b.type === "follow" ? "#E1F5EE" : "#F1EFE8", color: b.type === "follow" ? "#085041" : "#5F5E5A" }}>{b.type}</span>
                              </td>
                              <td style={{ textAlign: "center" }}><button onClick={() => removeBacklink(selectedSite, b.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#A32D2D", padding: 4 }}><Trash2 size={14} /></button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "28px 16px", color: "#888780" }}>
                      <Link2 size={18} /><span style={{ fontSize: 13 }}>被リンク未登録です。上のフォームから追加してください。</span>
                    </div>
                  )}
                </>
              ) : <div style={{ padding: 24, color: "#888780", fontSize: 13 }}>左から店舗を選択してください。</div>}
            </div>
          </div>
        </>
      )}

      {mode === "keywords" && data.keywords && (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <p style={{ fontSize: 13, color: "#5F5E5A", margin: 0, maxWidth: 620, lineHeight: 1.6 }}>
              楽天の検索上位・ランキング掲載の<strong>実在する上位商品タイトル</strong>から、各カテゴリで繰り返し使われている語を抽出しました。
              数値は<strong>検索ボリュームではなく</strong>「上位商品が実際にタイトルへ入れている＝有効と判断している語」の出現数（{"／"}サンプル商品数）です。商品名・説明文への採用候補にどうぞ。
            </p>
            <button onClick={exportKeywordsCsv} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", fontSize: 13, background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer", color: "#444441", whiteSpace: "nowrap" }}><Download size={14} /> CSVで書き出す</button>
          </div>

          {/* type legend */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {Object.entries(KW_TYPES).map(([name, t]) => (
              <span key={name} title={t.desc} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 9px", borderRadius: 6, background: t.bg, color: t.color }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color }} /> {name}
              </span>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            {Object.entries(data.keywords).filter(([k]) => k !== "meta").map(([catName, catData]) => {
              const accent = catName === "エクオール" ? "#534AB7" : "#0F6E56";
              const terms = [...(catData.terms || [])].sort((a, b) => b.count - a.count);
              const maxCount = terms.length ? Math.max(...terms.map((t) => t.count)) : 1;
              return (
                <div key={catName} style={{ background: "#fff", border, borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: accent }} />
                      <span style={{ fontSize: 15, fontWeight: 500 }}>{catName}</span>
                    </div>
                    <span style={{ fontSize: 11.5, color: "#888780" }}>上位{catData.sample}商品のタイトルを分析</span>
                  </div>
                  <div>
                    {terms.map((t) => {
                      const ty = KW_TYPES[t.type] || { color: "#888780", bg: "#EFEDE8" };
                      return (
                        <div key={t.word} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "0.5px solid rgba(120,120,120,0.12)" }}>
                          <span style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: ty.bg, color: ty.color, flexShrink: 0, width: 48, textAlign: "center" }}>{t.type}</span>
                          <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.3, minWidth: 0 }}>{t.word}</span>
                          <div style={{ width: 70, height: 7, borderRadius: 4, background: "#F1EFEA", flexShrink: 0, overflow: "hidden" }}>
                            <div style={{ width: `${(t.count / maxCount) * 100}%`, height: "100%", borderRadius: 4, background: ty.color }} />
                          </div>
                          <span style={{ fontSize: 12, color: "#5F5E5A", width: 34, textAlign: "right", flexShrink: 0 }}>{t.count}/{catData.sample}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {data.keywords.meta?.note && (
            <p style={{ fontSize: 11.5, color: "#A09E98", margin: "14px 2px 0", lineHeight: 1.6 }}>
              <AlertCircle size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
              {data.keywords.meta.note}（抽出日: {data.keywords.meta.sampledAt}）
            </p>
          )}
        </>
      )}

      {/* footer */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "#888780", marginTop: 18 }}>
        <button onClick={exportJson} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer", color: "#444441" }}><Download size={14} /> データを書き出す</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer", color: "#444441" }}><Upload size={14} /> 読み込む<input type="file" accept="application/json" onChange={importJson} style={{ display: "none" }} /></label>
      </div>
    </div>
  );
}
