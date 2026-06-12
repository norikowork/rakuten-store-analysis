import React from "react";
import { createRoot } from "react-dom/client";
import SupplementTracker from "./SupplementTracker";

// シンプルなlocalStorageラッパー
if (typeof window !== "undefined" && !(window as any).storage) {
  (window as any).storage = {
    async get(key: string) {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    },
    async set(key: string, value: string) {
      localStorage.setItem(key, value);
      return true;
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
  #root { padding: 0; }
  code { background: rgba(120,120,120,0.12); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <SupplementTracker />
);