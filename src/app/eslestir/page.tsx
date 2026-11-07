"use client";
import { useEffect, useState } from "react";

// Token URL fragment'ından okunur (sunucuya gitmez), localStorage'a yazılır, URL'den silinir (K-T4).
export default function Pair() {
  const [msg, setMsg] = useState("Eşleştiriliyor…");
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    if (!t) { setMsg("Bağlantıda token yok. Terminaldeki eşleştirme bağlantısını açın."); return; }
    const key = "asena:v1:settings";
    let s: Record<string, unknown> = {};
    try { s = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { /* */ }
    const engine = (s.engine as Record<string, unknown>) ?? { url: "http://127.0.0.1:8787" };
    s.engine = { ...engine, url: engine.url ?? "http://127.0.0.1:8787", token: t };
    localStorage.setItem(key, JSON.stringify(s));
    history.replaceState(null, "", "/eslestir");
    setMsg("Motor eşleştirildi ✓ Demo ekranına yönlendiriliyorsunuz…");
    setTimeout(() => { window.location.href = "/demo"; }, 900);
  }, []);
  return <div className="p-10 text-lg">{msg}</div>;
}
