"use client";
// Motor bağlı/eşleşmiş değilse gösterilen kurulum kartı: kopyalanabilir komutlar (bu sitenin adresiyle), token yapıştırma, e-postayla gönderme.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Health } from "@/lib/engine-client/client";
import { app } from "@/lib/app";

const ENGINE_DIR = "~/Projects/asena/engine";

function Cmd({ cmd }: { cmd: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-zinc-900 p-2 text-[12px] text-zinc-100">{cmd}</pre>
      <Button size="xs" variant="outline" onClick={async () => { await navigator.clipboard.writeText(cmd); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? "Kopyalandı" : "Kopyala"}</Button>
    </div>
  );
}

export function setupCommands(origin: string) {
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const origins = ["http://localhost:3000", origin].filter((v, i, a) => a.indexOf(v) === i).join(",");
  return {
    isLocal,
    start: isLocal ? `cd ${ENGINE_DIR} && uv run asena-engine` : `cd ${ENGINE_DIR} && ASENA_ALLOWED_ORIGINS=${origins} uv run asena-engine`,
    token: "cat ~/.asena/token | pbcopy",
    ollama: "ollama serve",
  };
}

export default function SetupCard({ h, onRetry }: { h: Health | { error: string } | null; onRetry: () => void }) {
  const [tok, setTok] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const c = setupCommands(origin);
  const unreachable = !h || "error" in h;
  const unpaired = !!h && !("error" in h) && !h.paired;
  const notReady = !!h && !("error" in h) && h.paired && (h.tts?.some((t) => t.status !== "hazir") || h.llm?.status !== "hazir");
  if (!unreachable && !unpaired && !notReady) return null;

  const mailBody = [
    "Asena demo kurulumu",
    "",
    `Site: ${origin}/demo`,
    "",
    "1) Mac'te terminalde yerel motoru başlat:",
    c.start,
    "",
    "2) Token'ı panoya kopyala:",
    c.token,
    "",
    `3) ${origin}/demo sayfasında 'Token' kutusuna yapıştır ve Kaydet'e bas.`,
    "",
    "Chrome 'yerel cihazlara erişim' izni sorarsa İzin ver.",
    "Reddettiysen: adres çubuğundaki site ayarları → Yerel ağ erişimi → İzin ver.",
  ].join("\n");

  const save = () => {
    const t = tok.trim().replace(/^.*#t=/, "");
    if (!t) return;
    app().repo.patchSettings((s) => { s.engine.token = t; });
    setTok("");
    onRetry();
  };

  return (
    <section className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">
          {unreachable ? "Demo motorsuz çalışıyor (kural + şablon cümleler, tarayıcının Türkçe sesi). Gerçek modeller (EMA, Antalia, Kumru) için Mac'te yerel motoru başlatın:" : unpaired ? "Motor çalışıyor ama bu site eşleşmemiş" : "Motor eşleşti, modeller hazırlanıyor"}
        </h2>
        <Button size="xs" variant="outline" onClick={onRetry}>Tekrar dene</Button>
        <a className="text-xs underline" href={`mailto:?subject=${encodeURIComponent("Asena demo kurulumu")}&body=${encodeURIComponent(mailBody)}`}>Talimatları e-postayla gönder</a>
      </div>
      {notReady && !unreachable && !unpaired ? (
        <p className="text-xs">TTS: {h && !("error" in h) ? h.tts?.map((t) => `${t.name} ${t.status}`).join(", ") : ""} · LLM: {h && !("error" in h) ? h.llm?.status : ""}. Birkaç saniye içinde hazır olur; Ollama kapalıysa terminalde <code>ollama serve</code> çalıştırın.</p>
      ) : (
        <ol className="grid gap-3 lg:grid-cols-3">
          <li className={unreachable ? "" : "opacity-50"}>
            <div className="mb-1 font-medium">1. Motoru başlat (Mac terminali)</div>
            <Cmd cmd={c.start} />
            {!c.isLocal && <p className="mt-1 text-xs">Komut bu sitenin adresini ({origin}) izinli listeye ekler.</p>}
          </li>
          <li>
            <div className="mb-1 font-medium">2. Token'ı kopyala</div>
            <Cmd cmd={c.token} />
            <p className="mt-1 text-xs">ya da motorun terminale bastığı <code>{origin}/eslestir#t=…</code> bağlantısını açın.</p>
          </li>
          <li>
            <div className="mb-1 font-medium">3. Buraya yapıştır</div>
            <div className="flex gap-1">
              <Input className="h-8 bg-white" placeholder="Token veya eşleştirme bağlantısı" value={tok} onChange={(e) => setTok(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
              <Button size="sm" onClick={save} disabled={!tok.trim()}>Kaydet</Button>
            </div>
          </li>
        </ol>
      )}
      {unreachable && !c.isLocal && (
        <p className="mt-3 text-xs">
          Motor açık ama yine bağlanmıyorsa: Chrome, bu sitenin bilgisayarınızdaki <code>127.0.0.1</code> adresine erişimi için izin ister. İzni reddettiyseniz adres çubuğundaki site ayarları simgesi → <b>Yerel ağ erişimi</b> → <b>İzin ver</b>, sonra sayfayı yenileyin. Safari desteklenmez; Chrome kullanın.
        </p>
      )}
    </section>
  );
}
