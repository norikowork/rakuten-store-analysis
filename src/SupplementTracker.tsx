import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  Plus, Trash2, Download, Upload, Save, TrendingUp, Check, AlertCircle, Pencil, Link2, ExternalLink, Tags, RefreshCw, Settings, X, Search, Trophy,
} from "lucide-react";

// 認証SDKを動的インポート
let auth: any = null;
if (typeof window !== "undefined") {
  import("./lib/shared/kliv-auth.js").then((m) => { auth = m.default; });
}

// lz-stringの圧縮・解凍（CommonJS形式）
async function getLZString() {
  // @ts-ignore
  const lz = await import("lz-string");
  return lz.default || lz;
}

async function compressToBase64Impl(str: string): Promise<string> {
  const lz = await getLZString();
  return lz.compressToBase64(str);
}

async function decompressFromBase64Impl(str: string): Promise<string | null> {
  const lz = await getLZString();
  return lz.decompressFromBase64(str);
}

// 圧縮・解凍の共通関数（後方互換）
async function saveStateToDB(key: string, value: string): Promise<{ ok: boolean; status: number }> {
  try {
    const compressed = await compressToBase64Impl(value);
    
    // 認証ヘッダーを追加
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    
    if (auth) {
      try {
        const user = await auth.getUser();
        if (user) {
          headers["x-user-uuid"] = user.uuid || "";
        }
      } catch (e) {
        console.warn("ユーザー情報取得エラー:", e);
      }
    }
    
    const res = await fetch("/api/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ key, value: compressed })
    });
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    console.error("DB保存例外:", e);
    return { ok: false, status: 0 };
  }
}

async function loadStateFromDB(key: string): Promise<{ value: string | null } | null> {
  try {
    const headers: Record<string, string> = {};
    
    if (auth) {
      try {
        const user = await auth.getUser();
        if (user) {
          headers["x-user-uuid"] = user.uuid || "";
        }
      } catch (e) {
        console.warn("ユーザー情報取得エラー:", e);
      }
    }
    
    const res = await fetch(`/api/state?key=${key}`, { headers });
    if (!res.ok) {
      console.warn("DB取得失敗:", res.status);
      return null;
    }
    const data = await res.json();
    if (!data.value) return { value: null };
    
    // まず非圧縮としてJSON.parseを試みる（後方互換）
    try {
      const parsed = JSON.parse(data.value);
      return { value: data.value }; // 非圧縮データ
    } catch {
      // JSON parse失敗 → 圧縮データとして解凍
      try {
        const decompressed = await decompressFromBase64Impl(data.value);
        return { value: decompressed };
      } catch (decompressErr) {
        console.error("解凍失敗:", decompressErr);
        return { value: null };
      }
    }
  } catch (e: any) {
    console.error("DB取得例外:", e);
    return null;
  }
}

const STORAGE_KEY = "rakuten-supp-tracker-v3";

// ---- 楽天市場 商品検索API（RMS OpenAPI版）----
// dev: Viteプロキシ経由（Originを登録ドメインに偽装／CORS回避）。本番: ブラウザから直叩き（登録ドメイン上で実Originが飛ぶ）。
const RAKUTEN_API_PATH = "/ichibams/api/IchibaItem/Search/20260401";
const RAKUTEN_BASE = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV)
  ? "/rk-proxy"                              // → vite.config.js のプロキシへ
  : "https://openapi.rakuten.co.jp";          // 本番は直接
const ENV = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1商品ぶんの最新値を取得。itemCode優先、0件ならkeyword+shopCodeへフォールバック（2026-04-01 API版）。
async function fetchRakutenItem(product, appId, accessKey, attempt = 1, useKeyword = false) {
  const params = new URLSearchParams({ format: "json", formatVersion: "2", applicationId: appId, accessKey });
  const byItemCode = product.itemCode && !useKeyword;
  if (byItemCode) {
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
    return fetchRakutenItem(product, appId, accessKey, attempt + 1, useKeyword);
  }
  if (json && (json.error || json.errors)) {
    throw new Error(json.error_description || json.errors?.errorMessage || json.error || `HTTP ${res.status}`);
  }
  const raw = json?.Items?.[0];
  const item = raw ? (raw.Item || raw) : null;
  if (!item) {
    // itemCodeで0件 → keyword+shopCodeでもう一度だけ試す（itemCode失効対策）
    if (byItemCode && (product.keyword || product.shopCode || product.name)) {
      await new Promise((r) => setTimeout(r, 800));
      return fetchRakutenItem(product, appId, accessKey, 1, true);
    }
    throw new Error("該当商品が見つかりません");
  }
  const num = (v) => (v == null || v === "" ? null : Number(v));
  // フォールバックしたかどうかをフラグとして返す
  return { 
    reviews: num(item.reviewCount), 
    price: num(item.itemPrice), 
    name: item.itemName, 
    url: item.itemUrl, 
    itemCode: item.itemCode,
    actualName: item.itemName,
    actualItemCode: item.itemCode,
    isFallback: useKeyword
  };
}

// 楽天商品ランキングを取得（genreIdベース、page1のみ）
async function fetchRanking(genreId, appId, accessKey) {
  const RANKING_BASE = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601";
  const rankingMap = {}; // { itemCode: rank }
  const params = new URLSearchParams({ format: "json", formatVersion: "2", applicationId: appId, accessKey, genreId });
  try {
    const res = await fetch(`${RANKING_BASE}?${params.toString()}`);
    if (!res.ok) { console.warn("ランキングAPI失敗:", res.status); return rankingMap; }
    const json = await res.json();
    if (json.error) { console.warn("ランキングAPIエラー:", json.error, json.error_description); return rankingMap; }
    const items = json.Items || json.items || [];   // ← Items（大文字）
    for (const it of items) {
      if (it.itemCode && it.rank != null) rankingMap[it.itemCode] = it.rank;
    }
    console.log(`📊 ランキング取得: ${Object.keys(rankingMap).length}件 (genre ${genreId})`);
  } catch (e) { console.warn("ランキング例外:", e.message); }
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

const NG_KEYWORDS = [
  "症状","吸収","減少","効果","必要","十分な","しっかり","むくみ",
  "最高純度","最高品質","最高水準","最高","安全","驚きの","最適","ダントツ","強力","理想","特別","贅沢","神サプリ","神","パワー",
  "アンチエイジング","若返り","若々しさ","女性ホルモン","ホルモンバランス","ゆらぎ","揺らぎ","ダブルケア","年齢とともに変化する女性","年齢にふさわしい美しさ",
  "輝く","美しさ","美しく","美容成分","美容","美",
  "シークレット","あなたをサポート",
];
function findNgWords(text) {
  if (!text) return [];
  return [...new Set(NG_KEYWORDS.filter((w) => text.includes(w)))];
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
const todayStr = () => ymd(new Date());
function todayStrSafe() { return ymd(new Date()); }
function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;   // 月曜始まり
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

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
  searchKeywords: { "エクオール": [], "カリウム": [] },
  bestsellers: { "エクオール": { history: {} }, "カリウム": { history: {} } },
};

const monthKey = (dateStr) => dateStr.slice(0, 7);

const METRICS = {
  reviews: { label: "レビュー数", unit: "件", betterHigh: true },
  rank: { label: "ランキング順位", unit: "位", betterHigh: false },
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
  const [ngInput, setNgInput] = useState("");
  const [skInput, setSkInput] = useState("");
  const [skCat, setSkCat] = useState("エクオール");
  const [skPage, setSkPage] = useState(1);
  const [bsCat, setBsCat] = useState("エクオール");
  const SK_PER_PAGE = 100;

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
        
        // 結果に商品情報を追加
        results.push({ 
          name: p.name, 
          ok: true, 
          reviews: r.reviews, 
          price: r.price, 
          rank,
          actualName: r.actualName,
          actualItemCode: r.actualItemCode,
          isFallback: r.isFallback
        });
      } catch (e) {
        results.push({ 
          name: p.name, 
          ok: false, 
          err: String(e.message || e) 
        });
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
          searchKeywords: (d.searchKeywords && !Array.isArray(d.searchKeywords)) ? d.searchKeywords : { "エクオール": [], "カリウム": [] },
          bestsellers: d.bestsellers || { "エクオール": { history: {} }, "カリウム": { history: {} } },
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
    try {
      setData(next);
      // ローカル保存のみ（DB保存は削除）
      const ok = await persist(next);
      flash(ok ? (msg || "保存しました") : "メモリに保存（このタブのみ）");
    } catch (e) {
      console.error("保存エラー:", e);
      flash("保存に失敗しました");
    }
  }, []);

  const saveEntry = async () => {
    try {
      console.log("記録開始");
      flash("記録中...");
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
      console.log("記録完了");
    } catch (e) {
      console.error("記録エラー:", e);
      flash("🟠 記録に失敗しました");
    }
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

  const importSearchKeywords = async () => {
    const lines = skInput.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const cur = (data.searchKeywords && data.searchKeywords[skCat]) || [];
    const map = new Map(cur.map((k) => [k.word, { ...k }]));
    for (const l of lines) {
      const m = l.split(/[,\t]/);
      const word = (m[0] || "").trim();
      if (!word) continue;
      const vol = m[1] != null ? Number(String(m[1]).replace(/[^0-9]/g, "")) : NaN;
      const ex = map.get(word);
      if (ex) {
        ex.count = (ex.count || 1) + 1;
        if (Number.isFinite(vol)) ex.volume = vol;
      } else {
        map.set(word, { word, count: 1, volume: Number.isFinite(vol) ? vol : null });
      }
    }
    const next = [...map.values()].sort((a, b) => (b.count || 0) - (a.count || 0) || (b.volume || 0) - (a.volume || 0));
    await commit({ ...data, searchKeywords: { ...(data.searchKeywords || {}), [skCat]: next } }, `${skCat}に${lines.length}語インポートしました`);
    setSkInput("");
    setSkPage(1);
  };
  const clearSearchKeywords = async () => {
    await commit({ ...data, searchKeywords: { ...(data.searchKeywords || {}), [skCat]: [] } }, "検索キーワードをクリアしました");
  };
  const removeSearchKeyword = async (word) => {
    const cur = (data.searchKeywords?.[skCat] || []).filter((k) => k.word !== word);
    await commit({ ...data, searchKeywords: { ...(data.searchKeywords || {}), [skCat]: cur } }, "削除しました");
  };
  // ---- 売れ筋ランキング ----
  const fetchBestsellers = async (genreId, appId, accessKey) => {
    const R = "https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601";
    const params = new URLSearchParams({ format: "json", formatVersion: "2", applicationId: appId, accessKey, genreId });
    const res = await fetch(`${R}?${params.toString()}`);
    const json = await res.json();
    const items = (json.Items || json.items || []).slice().sort((a, b) => (a.rank || 999) - (b.rank || 999));
    return items.slice(0, 15).map((it) => ({
      rank: it.rank, itemCode: it.itemCode, name: it.itemName, shop: it.shopName,
      reviews: it.reviewCount, reviewAvg: it.reviewAverage, price: it.itemPrice, url: it.itemUrl,
    }));
  };
  const fetchBestsellersAll = async () => {
    if (!appId.trim() || !accessKey.trim()) { setShowApiCfg(true); flash("APIキーを設定してください"); return; }
    setFetching(true);
    const GENRE = { "エクオール": "567631", "カリウム": "214787" };
    const today = todayStr();
    const next = { ...(data.bestsellers || {}) };
    for (const [cat, gid] of Object.entries(GENRE)) {
      try {
        const top15 = await fetchBestsellers(gid, appId.trim(), accessKey.trim());
        const cur = next[cat] || { history: {} };
        next[cat] = { ...cur, history: { ...cur.history, [today]: top15 } };
      } catch (e) {
        console.error(`売れ筋取得エラー(${cat}):`, e);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await commit({ ...data, bestsellers: next }, "売れ筋ランキングを記録しました");
    setFetching(false);
  };


  const exportJson = () => {
    try {
      console.log("書き出し開始");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `rakuten-supp-${todayStr()}.json`; a.click();
      URL.revokeObjectURL(url);
      console.log("書き出し完了");
      flash("🟢 データを書き出しました");
    } catch (e) {
      console.error("書き出しエラー:", e);
      flash("🟠 書き出しに失敗しました");
    }
  };
  const exportKeywordsCsv = () => {
    const rows = [["カテゴリ", "キーワード候補", "上位タイトル出現数", "サンプル商品数", "分類"]];
    Object.entries(data.keywords || {}).filter(([k]) => k !== "meta").forEach(([cat, cd]) => {
      (cd.terms || []).forEach((t) => {
        const word = findNgWords(t.word).length > 0 ? `（NG用語）${t.word}` : t.word;
        rows.push([cat, word, t.count, cd.sample, t.type]);
      });
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `rakuten-keywords-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        flash("読み込み中...");
        const p = JSON.parse(reader.result);
        if (p.products) {
          // ローカルにのみ保存（DB保存は削除）
          await commit({ 
            products: p.products, 
            logs: p.logs || {}, 
            sites: p.sites || SEED.sites, 
            backlinks: p.backlinks || {}, 
            keywords: p.keywords || SEED.keywords, 
            searchKeywords: p.searchKeywords || { "エクオール": [], "カリウム": [] }, 
            bestsellers: p.bestsellers || { "エクオール": { history: {} }, "カリウム": { history: {} } } 
          }, "読み込みしました");
          
          flash("🟢 読み込み完了（ローカル保存成功）");
        } else {
          flash("🟠 読み込み失敗（productsがありません）");
        }
      } catch (err) {
        console.error("インポートエラー:", err);
        flash("🟠 読み込みに失敗しました");
      }
    };
    reader.readAsText(file); 
    e.target.value = "";
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
      for (let i = dates.length - 1; i >= 0; i--) { 
        const v = logs[dates[i]][metric]; 
        // 数値型を保証
        if (v != null && typeof v === "number") return v; 
      }
      return null;
    };
    return periods.map((period) => {
      const row = { period };
      visible.forEach((p) => { 
        const val = valueForPeriod(p.id, period);
        row[p.id] = val != null && typeof val === "number" ? val : null;
      });
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
    // 最新の価格を取得
    const allDates = Object.keys(data.logs[p.id] || {}).sort().reverse();
    const latestPrice = allDates.length ? (data.logs[p.id][allDates[0]]?.price) : null;
    return { p, latest, delta, latestPrice };
  }), [visible, chart, data.logs]);

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
        <button onClick={() => setMode("searchkw")} style={{ ...tab(mode === "searchkw", "#185FA5", "#E2EEFA", "#0E3F6E"), display: "flex", alignItems: "center", gap: 6 }}><Search size={15} /> 検索キーワード</button>
        <button onClick={() => setMode("bestsellers")} style={{ ...tab(mode === "bestsellers", "#7955D4", "#F3E5FF", "#4B2482"), display: "flex", alignItems: "center", gap: 6 }}><Trophy size={15} /> 売れ筋ランキング</button>
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
            {summary.map(({ p, latest, delta, latestPrice }) => (
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
                {latestPrice != null && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "#888780", fontWeight: 400 }}>
                    ¥{latestPrice.toLocaleString()}
                  </div>
                )}
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
                  <YAxis 
                    reversed={metric === "rank"} 
                    tick={{ fontSize: 11, fill: "#888780" }} 
                    width={48} 
                    tickFormatter={(v) => v != null ? v.toLocaleString() : "—"} 
                    domain={metric === "rank" ? [1, "auto"] : ["auto", "auto"]} 
                    scale={metric === "rank" ? "ordinal" : "linear"}
                  />
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
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", borderRadius: 6, background: r.ok ? "#E9F6F1" : "#FBEBEB" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {r.ok ? <Check size={13} style={{ color: "#0F6E56", flexShrink: 0 }} /> : <X size={13} style={{ color: "#A32D2D", flexShrink: 0 }} />}
                      <span style={{ flex: 1, minWidth: 0, color: "#444441", fontWeight: 500 }}>{r.name}</span>
                      {r.isFallback && <span style={{ fontSize: 11, padding: "2px 6px", background: "#FFF4E5", color: "#F5A623", borderRadius: 4, border: "0.5px solid rgba(245,166,35,0.3)" }}>⚠️ 別商品の可能性（キーワード検索）</span>}
                      <span style={{ color: "#5F5E5A" }}>レビュー {r.reviews?.toLocaleString() ?? "—"} / ¥{r.price?.toLocaleString() ?? "—"}</span>
                    </div>
                    {r.ok && (
                      <div style={{ display: "flex", gap: 6, fontSize: 11.5, color: "#888780", marginLeft: 21 }}>
                        <span>取得: {r.actualName}</span>
                        <span>itemCode: {r.actualItemCode}</span>
                      </div>
                    )}
                    {!r.ok && <span style={{ color: "#A32D2D", fontSize: 12 }}>{r.err}</span>}
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
                    <th style={{ padding: "6px 8px", fontWeight: 400, fontSize: 14 }}>商品</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 110, fontSize: 14 }}>レビュー数</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 90, fontSize: 14 }}>順位</th>
                    <th style={{ padding: "6px 8px", fontWeight: 400, width: 110, fontSize: 14 }}>価格(円)</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.id} style={{ borderTop: "0.5px solid rgba(120,120,120,0.15)" }}>
                      <td style={{ padding: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ width: 9, height: 9, borderRadius: 3, background: colorFor(data.products, p.id), flexShrink: 0 }} />
                          <div><div style={{ lineHeight: 1.3, fontSize: 14 }}>{p.name}</div><div style={{ fontSize: 11, color: "#888780" }}>{p.store}</div></div>
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
          {/* NGキーワードチェックカード */}
          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={16} style={{ color: "#D85A30" }} />
              NGキーワードチェック（薬機法・誇大表現）
            </div>
            <textarea 
              value={ngInput} 
              onChange={(e) => setNgInput(e.target.value)}
              placeholder="商品タイトルを貼り付けてチェック…" 
              style={{ 
                width: "100%", 
                minHeight: 80, 
                padding: "10px 12px", 
                fontSize: 13, 
                border: "0.5px solid rgba(120,120,120,0.3)", 
                borderRadius: 8, 
                resize: "vertical",
                fontFamily: "inherit"
              }}
            />
            {ngInput && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {(() => {
                  const found = findNgWords(ngInput);
                  if (found.length > 0) {
                    return (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: "#FBEBEB", borderRadius: 8, border: "0.5px solid #FCC" }}>
                          <AlertCircle size={14} style={{ color: "#A32D2D" }} />
                          <span style={{ fontSize: 13, color: "#A32D2D", fontWeight: 500 }}>⚠️ NGワードが{found.length}件見つかりました</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {found.map((w) => (
                            <span key={w} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: "#FBEBEB", color: "#A32D2D", border: "0.5px solid #FCC", fontWeight: 500 }}>⚠️ {w}</span>
                          ))}
                        </div>
                      </>
                    );
                  } else {
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: "#E9F6F1", borderRadius: 8, border: "0.5px solid #1D9E75" }}>
                        <Check size={14} style={{ color: "#0F6E56" }} />
                        <span style={{ fontSize: 13, color: "#0F6E56", fontWeight: 500 }}>✅ NGワードは見つかりませんでした</span>
                      </div>
                    );
                  }
                })()}
              </div>
            )}
          </div>

          {/* 📊 リコメンド（検索キーワード × 上位7商品タイトル） */}
          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px 8px", fontSize: 14, fontWeight: 500, color: "#5F5E5A" }}>
              📊 リコメンド（検索キーワード × 上位7商品タイトル）
            </div>
            
            {(() => {
              const cats = ["エクオール", "カリウム"];
              return cats.map(cat => {
                const bsHistory = data.bestsellers?.[cat]?.history || {};
                const dates = Object.keys(bsHistory).sort();
                const latest = dates.length ? bsHistory[dates[dates.length - 1]] || [] : [];
                const top7 = latest.slice(0, 7);
                
                const searchKws = data.searchKeywords?.[cat] || [];
                const terms = data.keywords?.[cat]?.terms || [];
                
                // 案内表示
                if (top7.length === 0) {
                  return (
                    <div key={cat} style={{ marginBottom: 16, padding: 16, background: "#F7F6F2", borderRadius: 8, textAlign: "center", fontSize: 13, color: "#888780" }}>
                      売れ筋ランキングを取得すると表示されます
                    </div>
                  );
                }
                
                if (searchKws.length === 0) {
                  return (
                    <div key={cat} style={{ marginBottom: 16, padding: 16, background: "#F7F6F2", borderRadius: 8, textAlign: "center", fontSize: 13, color: "#888780" }}>
                      検索キーワードをインポートすると表示されます
                    </div>
                  );
                }
                
                // 表記ゆれ展開関数
                const expandVariations = (word) => {
                  const variations = [];
                  const parts = word.split(/\/|・/);
                  parts.forEach(part => {
                    const trimmed = part.trim();
                    if (trimmed) {
                      const withoutParen = trimmed.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
                      if (withoutParen) {
                        variations.push(withoutParen);
                      }
                    }
                  });
                  return variations;
                };
                
                // 各語の分析
                const analyzed = terms.map(term => {
                  const variations = expandVariations(term.word);
                  const titleHits = top7.filter(item => {
                    const title = item.name || "";
                    return variations.some(v => title.includes(v));
                  }).length;
                  const searchHits = searchKws.filter(kw => {
                    return variations.some(v => kw.word.includes(v));
                  }).length;
                  return { word: term.word, type: term.type, titleHits, searchHits };
                });
                
                // グループ分け
                const ironPlate = analyzed.filter(t => t.titleHits >= 4 && t.searchHits >= 50);
                const chance = analyzed.filter(t => t.searchHits >= 5 && t.titleHits <= 1 && t.type !== "信頼");
                const trust = analyzed.filter(t => t.type === "信頼" && t.titleHits >= 3);
                
                // ソート（searchHits降順）
                const sortByHits = (arr) => [...arr].sort((a, b) => b.searchHits - a.searchHits);
                
                const accent = cat === "エクオール" ? "#534AB7" : "#0F6E56";
                const typeColors = {
                  成分: "#0F6E56", 規格: "#185FA5", 訴求: "#C2541F", 信頼: "#534AB7", 実績: "#993556", 対象: "#7A5A1E", ブランド: "#5F5E5A"
                };
                
                return (
                  <div key={cat} style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 15, fontWeight: 500 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: accent }} />
                      {cat}
                    </div>
                    
                    {/* 🟢 鉄板 */}
                    {ironPlate.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "#0F6E56", marginBottom: 6 }}>🟢 鉄板（検索も多く上位も使う）</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {sortByHits(ironPlate).map(t => (
                            <div key={t.word} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "4px 8px", background: "#E9F6F1", borderRadius: 6 }}>
                              <span style={{ flex: 1, fontWeight: 500 }}>{t.word}</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>タイトル {t.titleHits}/7</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>検索 {t.searchHits}件</span>
                              <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: typeColors[t.type] || "#EFEDE8", color: "#fff" }}>{t.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* 🟡 チャンス */}
                    {chance.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "#F5A623", marginBottom: 6 }}>🟡 チャンス（検索されてるのに上位タイトルが手薄）</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {sortByHits(chance).map(t => (
                            <div key={t.word} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "4px 8px", background: "#FFF4E5", borderRadius: 6 }}>
                              <span style={{ flex: 1, fontWeight: 500 }}>{t.word}</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>タイトル {t.titleHits}/7</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>検索 {t.searchHits}件</span>
                              <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: typeColors[t.type] || "#EFEDE8", color: "#fff" }}>{t.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* 🔵 信頼の定番 */}
                    {trust.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: "#185FA5", marginBottom: 6 }}>🔵 信頼の定番（上位が必ず入れる信頼ワード）</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {sortByHits(trust).map(t => (
                            <div key={t.word} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "4px 8px", background: "#E2EEFA", borderRadius: 6 }}>
                              <span style={{ flex: 1, fontWeight: 500 }}>{t.word}</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>タイトル {t.titleHits}/7</span>
                              <span style={{ fontSize: 11, color: "#888780" }}>検索 {t.searchHits}件</span>
                              <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "#185FA5", color: "#fff" }}>{t.type}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* 該当なし */}
                    {ironPlate.length === 0 && chance.length === 0 && trust.length === 0 && (
                      <div style={{ padding: 12, fontSize: 12, color: "#888780", textAlign: "center" }}>
                        該当するリコメンドはありません
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
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
                      const ng = findNgWords(t.word);
                      return (
                        <div key={t.word} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "0.5px solid rgba(120,120,120,0.12)" }}>
                          <span style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: ty.bg, color: ty.color, flexShrink: 0, width: 48, textAlign: "center" }}>{t.type}</span>
                          <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.3, minWidth: 0 }}>{t.word}</span>
                          {ng.length > 0 && (
                            <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, background: "#FBEBEB", color: "#A32D2D", border: "0.5px solid #FCC", fontWeight: 500, flexShrink: 0 }}>⚠️ NG</span>
                          )}
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

        {mode === "bestsellers" && (
        <>

          {(() => {
            const bs = data.bestsellers?.[bsCat];
            const dates = Object.keys(bs?.history || {}).sort();
            const latest = dates.length ? bs.history[dates[dates.length - 1]] : [];
            const latestSorted = [...latest].sort((a, b) => (a.rank || 999) - (b.rank || 999));
            const countOf = (code) => dates.filter((d) => (bs.history[d] || []).some((x) => x.itemCode === code)).length;

            return (
              <div style={{ background: "#fff", border, borderRadius: 12, padding: "16px 12px 8px", marginBottom: 22 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px 8px", fontSize: 13, color: "#5F5E5A", marginBottom: 12 }}>
                  <Trophy size={15} /> {bsCat} 売れ筋ランキング（Top15）
                </div>
                {latest.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: "#888780", textAlign: "left" }}>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>順位</th>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>商品（店舗）</th>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>レビュー数</th>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>平均</th>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>Top15入り回数</th>
                        <th style={{ padding: "6px 8px", fontWeight: 400 }}>価格</th>
                      </tr>
                    </thead>
                    <tbody>
                      {latestSorted.map((item, i) => (
                        <tr key={item.itemCode} style={{ borderTop: "0.5px solid rgba(120,120,120,0.15)" }}>
                          <td style={{ padding: "8px" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 500, color: "#7955D4", width: 24, textAlign: "center" }}>
                              {item.rank || i + 1}
                            </span>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <div style={{ fontSize: 13 }}>
                              <div style={{ fontWeight: 400 }}>{item.name}</div>
                              <div style={{ fontSize: 11, color: "#888780", marginTop: 2 }}>{item.shop}</div>
                            </div>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <span style={{ fontSize: 12, color: "#444441" }}>{item.reviews?.toLocaleString() || "—"}</span>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <span style={{ fontSize: 12, color: "#444441" }}>{item.reviewAvg ? "★" + item.reviewAvg : "—"}</span>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: countOf(item.itemCode) >= 5 ? "#7955D4" : "#444441" }}>
                              {countOf(item.itemCode)} 回
                            </span>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <span style={{ fontSize: 12, color: "#444441" }}>{item.price ? "¥" + item.price.toLocaleString() : "—"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "48px 16px", color: "#888780" }}>
                    <Trophy size={32} style={{ color: "#BDBDB8" }} />
                    <span style={{ fontSize: 13 }}>まだデータがありません。右上の「売れ筋を取得して記録」ボタンを押してください。</span>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}

      {mode === "searchkw" && (
        <>
          <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <Search size={18} style={{ color: "#185FA5" }} />
              検索キーワード（ラッコキーワード等から手動インポート）
            </div>
            <div style={{ fontSize: 13, color: "#5F5E5A", marginBottom: 12, lineHeight: 1.6 }}>
              ラッコキーワード等で調べた語を貼り付けて取り込みます。1行1語。『語,検索数』で検索数も取り込めます
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button onClick={() => setSkCat("エクオール")} style={{ padding: "8px 16px", fontSize: 13, fontWeight: 500, color: skCat === "エクオール" ? "#fff" : "#444441", background: skCat === "エクオール" ? "#534AB7" : "none", border: skCat === "エクオール" ? "none" : "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer" }}>エクオール</button>
              <button onClick={() => setSkCat("カリウム")} style={{ padding: "8px 16px", fontSize: 13, fontWeight: 500, color: skCat === "カリウム" ? "#fff" : "#444441", background: skCat === "カリウム" ? "#0F6E56" : "none", border: skCat === "カリウム" ? "none" : "0.5px solid rgba(120,120,120,0.3)", borderRadius: 8, cursor: "pointer" }}>カリウム</button>
            </div>
            <textarea 
              value={skInput} 
              onChange={(e) => setSkInput(e.target.value)}
              placeholder="エクオール おすすめ&#10;エクオール 比較,1200&#10;エクオール 効果,800"
              rows={6}
              style={{ 
                width: "100%", 
                padding: "12px", 
                fontSize: 13, 
                border: "0.5px solid rgba(120,120,120,0.3)", 
                borderRadius: 8, 
                resize: "vertical",
                fontFamily: "inherit",
                marginBottom: 12
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={importSearchKeywords} disabled={!skInput.trim()} style={{ padding: "10px 18px", fontSize: 14, fontWeight: 500, color: "#fff", background: skInput.trim() ? "#185FA5" : "#BDBDB8", border: "none", borderRadius: 8, cursor: skInput.trim() ? "pointer" : "default" }}>インポート</button>
            </div>
          </div>

          {data.searchKeywords && Object.keys(data.searchKeywords).length > 0 && (data.searchKeywords["エクオール"]?.length > 0 || data.searchKeywords["カリウム"]?.length > 0) ? (
            <div style={{ background: "#fff", border, borderRadius: 12, padding: 16, marginBottom: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>
                {skCat} 検索キーワードランキング（インポート回数順）
              </div>
              {(() => {
                const skAll = data.searchKeywords?.[skCat] || [];
                const skTotalPages = Math.max(1, Math.ceil(skAll.length / SK_PER_PAGE));
                const skPageSafe = Math.min(skPage, skTotalPages);
                const skShown = skAll.slice((skPageSafe - 1) * SK_PER_PAGE, skPageSafe * SK_PER_PAGE);
                return (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {skShown.map((k, i) => {
                        const ng = findNgWords(k.word);
                        return (
                          <div key={k.word} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px", background: "#F7F6F2", borderRadius: 8, border: "0.5px solid rgba(120,120,120,0.15)" }}>
                            <div style={{ fontSize: 16, fontWeight: 600, color: "#185FA5", width: 28, textAlign: "center", flexShrink: 0 }}>{(skPageSafe - 1) * SK_PER_PAGE + i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 15, color: "#444441", fontWeight: 500, marginBottom: 4 }}>{k.word}</div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {k.count && (
                                  <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, background: "#E2EEFA", color: "#185FA5", fontWeight: 500 }}>×{k.count} 回</span>
                                )}
                                {k.volume && (
                                  <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, background: "#E1F5EE", color: "#0F6E56", fontWeight: 500 }}>{k.volume.toLocaleString()}</span>
                                )}
                                {ng.length > 0 && (
                                  <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, background: "#FBEBEB", color: "#A32D2D", border: "0.5px solid #FCC", fontWeight: 500 }}>⚠️ NG</span>
                                )}
                              </div>
                            </div>
                            <button onClick={() => removeSearchKeyword(k.word)} style={{ padding: "8px 12px", fontSize: 13, background: "none", border: "0.5px solid rgba(120,120,120,0.3)", borderRadius: 6, cursor: "pointer", color: "#A32D2D" }}><Trash2 size={13} /></button>
                          </div>
                        );
                      })}
                    </div>
                    {skTotalPages > 1 && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
                        <button disabled={skPageSafe <= 1} onClick={() => setSkPage(skPageSafe - 1)} style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid rgba(120,120,120,0.3)", background: skPageSafe <= 1 ? "#F1EFEA" : "#fff", cursor: skPageSafe <= 1 ? "default" : "pointer" }}>← 前へ</button>
                        <span style={{ fontSize: 13, color: "#5F5E5A" }}>{skPageSafe} / {skTotalPages} ページ（全{skAll.length}件）</span>
                        <button disabled={skPageSafe >= skTotalPages} onClick={() => setSkPage(skPageSafe + 1)} style={{ padding: "6px 14px", borderRadius: 8, border: "0.5px solid rgba(120,120,120,0.3)", background: skPageSafe >= skTotalPages ? "#F1EFEA" : "#fff", cursor: skPageSafe >= skTotalPages ? "default" : "pointer" }}>次へ →</button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : (
            <div style={{ background: "#fff", border, borderRadius: 12, padding: 40, marginBottom: 18, textAlign: "center", color: "#888780" }}>
              <Search size={32} style={{ marginBottom: 12, color: "#BDBDB8" }} />
              <div style={{ fontSize: 14 }}>まだ取り込まれていません。</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>上に貼り付けてインポートしてください</div>
            </div>
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