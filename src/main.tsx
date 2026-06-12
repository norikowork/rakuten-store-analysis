import React from "react";
import { createRoot } from "react-dom/client";
import SupplementTracker from "./SupplementTracker";
import functions from "@/lib/shared/kliv-functions.js";

// このコンポーネントは window.storage 経由で永続化する。
// SQLite データベース経由で保存する（認証済みユーザーのみ利用可能）。
if (typeof window !== "undefined" && !(window as any).storage) {
  (window as any).storage = {
    async get(key: string) {
      try {
        const result = await functions.get("app-state-api", { key });
        if (result && result.value) {
          return { value: result.value };
        }
        return null;
      } catch (error) {
        console.error("storage.get error:", error);
        // Fallback to localStorage for development or when API fails
        const value = localStorage.getItem(key);
        return value == null ? null : { value };
      }
    },
    async set(key: string, value: string) {
      try {
        await functions.post("app-state-api", { key, value });
        return true;
      } catch (error) {
        console.error("storage.set error:", error);
        // Fallback to localStorage for development or when API fails
        try {
          localStorage.setItem(key, value);
          return true;
        } catch (e) {
          console.error("localStorage fallback failed:", e);
          return false;
        }
      }
    },
  };
}

const css = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #F7F6F2;
    font-family: system-ui, -apple-system, 'Hiragino Sans', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #root { padding: 28px 18px 64px; }
  code { background: rgba(120,120,120,0.12); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SupplementTracker />
  </React.StrictMode>
);