"use client";
import { useEffect, useMemo, useState } from "react";
import { app, useApp } from "@/lib/app";
import { health, type Health } from "@/lib/engine-client/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { audioCtx } from "@/lib/audio/player";
import { fmtShort, isoToMs, msToIso, slotCutoffMs, fmtDateTr } from "@/lib/domain/time";
import { spokenSlot } from "@/lib/domain/spoken";
import { sameDistrict } from "@/lib/domain/schemas";
import { caseCustomers, caseSlots, CASE_VARIANTS, normalizePhone } from "@/lib/seed";
import { uid } from "@/lib/store/repo";
import type { Customer, CourierSlot, Decision } from "@/lib/domain/types";
import { assignCharacters } from "@/lib/characters";
import { cn } from "@/lib/utils";
import { parseKb } from "@/lib/domain/kb";
import Rules from "./Rules";

const TABS = ["Panel", "Görüşme", "Toplu demo", "Kurallar", "Müşteriler", "Kuryeler", "Karar akışı", "Mesajlar", "Planlar", "Kurum bilgisi", "Ayarlar"] as const;
type Tab = (typeof TABS)[number];

function Box({ title, children, className, right }: { title: string; children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <section className={cn("rounded-xl border bg-background p-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{right}</div>
      {children}
    </section>
  );
}

const STATUS_COLOR: Record<string, string> = {
  randevu_verildi: "bg-emerald-100 text-emerald-800", bekleme_listesi: "bg-amber-100 text-amber-800", aranıyor: "bg-blue-100 text-blue-800",
  teslimat_donduruldu: "bg-red-100 text-red-800", kart_talep_itirazi: "bg-red-100 text-red-800", insana_aktarildi: "bg-purple-100 text-purple-800",
  aranmasin: "bg-zinc-200 text-zinc-700", geri_arama: "bg-sky-100 text-sky-800", ucuncu_kisi: "bg-sky-100 text-sky-800",
};
function Status({ s }: { s: string }) {
  return <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", STATUS_COLOR[s] ?? "bg-muted text-muted-foreground")}>{s}</span>;
}

// =====================================================================================
export default function Console() {
  const a = useApp();
  const [tab, setTab] = useState<Tab>("Panel");
  const [h, setH] = useState<Health | { error: string } | null>(null);
  const settings = a.repo.settings();
  const refresh = async () => setH(await health(settings.engine));
  useEffect(() => { void refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [settings.engine.token]); // eslint-disable-line

  const live = a.live;
  const go = (t: Tab) => setTab(t);
  const startCall = (id: string) => { audioCtx(); go("Görüşme"); void a.startCall(id); };

  return (
    <div className="mx-auto max-w-[1500px] p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">A</div>
          <div>
            <div className="font-semibold leading-tight">Asena · Operasyon konsolu</div>
            <div className="text-xs text-muted-foreground">Kurye kart teslimatı · sentetik veri · <span className="rounded bg-amber-100 px-1 text-amber-800">Sentetik ses</span></div>
          </div>
        </div>
        <EngineBadge h={h} onRetry={refresh} />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Simülasyon saati: <b className="text-foreground">{fmtShort(settings.simulation.now)}</b>
          <Button size="xs" variant="outline" onClick={() => a.repo.patchSettings((s) => { s.simulation.now = msToIso(isoToMs(s.simulation.now) + 3600_000); })}>+1 sa</Button>
          <Button size="xs" variant="destructive" disabled={!!(live && !live.outcome)} onClick={() => {
            if (!confirm("Demo sıfırlansın mı? Tüm randevular, bekleme listesi, notlar, planlar, bayraklar ve SMS'ler silinir; müşteriler, kurye yerleri ve karakterler kalır.")) return;
            a.batch = null; a.live = null;
            a.repo.resetOperations();
            a.repo.patchSettings((s) => { s.simulation.now = "2026-11-11T10:00:00+03:00"; });
          }}>↺ Demoyu sıfırla</Button>
        </div>
      </header>
      <nav className="mb-4 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => go(t)} className={cn("rounded-lg px-3 py-1.5 text-sm", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            {t}{t === "Görüşme" && live && !live.outcome ? " ●" : ""}
          </button>
        ))}
      </nav>
      {tab === "Panel" && <Panel onCall={startCall} onTab={go} />}
      {tab === "Görüşme" && <LiveCall />}
      {tab === "Toplu demo" && <Batch />}
      {tab === "Kurallar" && <Rules />}
      {tab === "Müşteriler" && <Customers onCall={startCall} />}
      {tab === "Kuryeler" && <Couriers />}
      {tab === "Karar akışı" && <Decisions />}
      {tab === "Mesajlar" && <Outbox />}
      {tab === "Planlar" && <Plans />}
      {tab === "Kurum bilgisi" && <Kb />}
      {tab === "Ayarlar" && <SettingsView h={h} onRetry={refresh} />}
    </div>
  );
}

function EngineBadge({ h, onRetry }: { h: Health | { error: string } | null; onRetry: () => void }) {
  if (!h) return <Badge variant="outline">Motor yoklanıyor…</Badge>;
  if ("error" in h) return <button onClick={onRetry}><Badge variant="destructive">Yerel motor bulunamadı · {h.error}</Badge></button>;
  if (!h.paired) return <Badge variant="destructive">Motor bağlı, eşleşmemiş</Badge>;
  const tts = h.tts?.map((t) => `${t.name} ${t.version}${t.status === "hazir" ? "" : ` (${t.status})`}`).join(" · ");
  return <Badge className="bg-emerald-600 text-white">Yerel motor bağlı · {tts} · {h.llm?.selected === "alibayram/kumru:latest" ? "Kumru-2B" : h.llm?.selected ?? h.llm?.status}</Badge>;
}

// =====================================================================================
function Capacity() {
  const a = useApp();
  const slots = a.repo.slots();
  const bookings = a.repo.bookings().filter((b) => b.status === "aktif");
  const holds = a.repo.holds().filter((h) => h.expiresAt > Date.now());
  const customers = a.repo.customers();
  const districts = [...new Set([...slots.map((s) => s.ilce), ...customers.map((c) => c.adresler[0]?.ilce)])].filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {slots.map((s) => {
          const b = bookings.filter((x) => x.slotId === s.id);
          const h = holds.filter((x) => x.slotId === s.id).length;
          const closed = slotCutoffMs(s) <= isoToMs(a.repo.now()) || !s.aktif;
          return (
            <div key={s.id} className={cn("rounded-lg border p-2 text-xs", closed && "opacity-50")}>
              <div className="flex justify-between font-medium"><span>{s.ilce}</span><span className="text-muted-foreground">{s.id}</span></div>
              <div className="text-muted-foreground">{spokenSlot(s)}</div>
              <div className="mt-1 flex gap-0.5">
                {Array.from({ length: s.kapasite }).map((_, i) => <div key={i} className={cn("h-2 flex-1 rounded", i < b.length ? "bg-emerald-500" : i < b.length + h ? "bg-amber-400" : "bg-muted")} />)}
              </div>
              <div className="mt-1">{b.length}/{s.kapasite} dolu{h ? ` · ${h} hold` : ""}{closed ? " · kapandı" : ""}</div>
              <div className="truncate text-muted-foreground">{b.map((x) => customers.find((c) => c.id === x.customerId)?.adSoyad).join(", ")}</div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {districts.map((d) => {
          const n = customers.filter((c) => sameDistrict(c.adresler.find((x) => x.id === c.teslimAdresId)?.ilce ?? "", d)).length;
          const cap = slots.filter((s) => sameDistrict(s.ilce, d) && s.aktif).reduce((x, s) => x + s.kapasite, 0);
          return <span key={d} className={cn("rounded-md border px-2 py-1", n > cap && "border-amber-400 bg-amber-50")}>{d}: {n} müşteri / {cap} yer {n > cap ? "⚠️" : ""}</span>;
        })}
        <span className="rounded-md border px-2 py-1 font-medium">Toplam: {customers.length} müşteri / {slots.filter((s) => s.aktif).reduce((x, s) => x + s.kapasite, 0)} yer</span>
      </div>
    </div>
  );
}

function Panel({ onCall, onTab }: { onCall: (id: string) => void; onTab: (t: Tab) => void }) {
  const a = useApp();
  const cs = a.repo.customers();
  const flags = a.repo.flagsAll();
  const sched = a.repo.schedules().filter((s) => s.status === "bekliyor");
  const lib = a.repo.characterLibrary();
  return (
    <div className="grid gap-4">
      <Box title="Kapasite (canlı)" right={<div className="flex gap-2"><Button size="sm" onClick={() => onTab("Toplu demo")}>▶ Toplu demo</Button><Button size="sm" variant="outline" onClick={() => { if (confirm("Simülasyon sıfırlansın mı? (randevu, not, plan, SMS silinir; karar günlüğü korunur)")) { a.repo.resetOperations(); a.repo.patchSettings((s) => { s.simulation.now = "2026-11-11T10:00:00+03:00"; }); } }}>Simülasyonu sıfırla</Button></div>}>
        <Capacity />
      </Box>
      <Box title={`Müşteriler (${cs.length})`}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Ad</th><th>İlçe / adres</th><th>Durum</th><th>Karakter</th><th>Sonraki plan</th><th>Bayrak</th><th /></tr></thead>
          <tbody>
            {cs.map((c) => {
              const f = flags[c.id] ?? {};
              const k = c.karakter;
              const ark = lib.arketipler.find((x) => x.id === k?.arketipId);
              const next = sched.filter((s) => s.customerId === c.id).sort((x, y) => isoToMs(x.dueAt) - isoToMs(y.dueAt))[0];
              const gate = a.svc.callGate(c.id);
              return (
                <tr key={c.id} className="border-t">
                  <td className="py-1.5 font-medium">{c.adSoyad}</td>
                  <td>{c.adresler.map((x) => `${x.ilce} (${x.tip})`).join(", ")}</td>
                  <td><Status s={c.durum} /></td>
                  <td className="text-xs">{ark ? `${ark.ad}${k?.sapmaIds.length ? ` · +${k.sapmaIds.join(",")}` : ""}` : <span className="text-red-600">yok</span>}</td>
                  <td className="text-xs">{next ? `${fmtShort(next.dueAt)} ${next.type}` : "—"}</td>
                  <td className="text-xs">{[f.aranmasin && "🔕", f.teslimat_donduruldu && "🧊", f.guvenlik_incelemesi && "🛡️", f.numara_gecersiz && "☎️✗"].filter(Boolean).join(" ")}</td>
                  <td className="text-right"><Button size="xs" disabled={!gate.ok || !!(a.live && !a.live.outcome)} title={gate.ok ? "" : gate.reason} onClick={() => onCall(c.id)}>Görüşmeyi başlat</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Box>
    </div>
  );
}

// =====================================================================================
const STATES = ["ACILIS", "KIMLIK_SOR", "UCUNCU_KISI", "AYDINLATMA", "DOGRULAMA", "AMAC", "SLOT_TEKLIF", "REZERVASYON", "TEYIT", "BEKLEME_LISTESI", "KURALLAR", "OZET", "GERI_ARAMA", "INSANA_AKTAR", "SONLANDIR"];

function LiveCall() {
  const a = useApp();
  const l = a.live;
  if (!l) return <Box title="Görüşme">Henüz görüşme yok. Panelden bir müşteri için “Görüşmeyi başlat”a basın.</Box>;
  const c = a.repo.customer(l.customerId);
  const decisions = a.repo.decisions().filter((d) => d.callId === l.callId).slice(-60).reverse();
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr_420px]">
      <Box title="Durum makinesi">
        <div className="space-y-0.5 text-xs">
          {STATES.map((s) => <div key={s} className={cn("rounded px-2 py-1", l.state === s ? "bg-primary text-primary-foreground" : l.history.includes(s as never) ? "bg-muted" : "text-muted-foreground")}>{s}</div>)}
        </div>
        <div className="mt-3 text-xs">verified: <b>{l.history.includes("AMAC") ? "evet" : "hayır"}</b></div>
        {l.outcome && <div className="mt-2 text-sm">Sonuç: <Status s={l.outcome} /><div className="mt-1 text-xs text-muted-foreground">{l.summary}</div></div>}
        {l.evaluation && <div className="mt-3 space-y-1 text-xs">{l.evaluation.checks.map((x) => <div key={x.id}>{x.status === "ok" ? "✅" : x.status === "uyari" ? "⚠️" : "❌"} {x.label}: {x.detail}</div>)}</div>}
      </Box>
      <Box title={`Transcript · ${c?.adSoyad ?? ""}`} right={
        <div className="flex gap-2">
          {!l.outcome && <Button size="xs" variant="outline" onClick={() => a.togglePause()}>{a.pauseFlag ? "Devam" : "Duraklat"}</Button>}
          {!l.outcome && <Button size="xs" variant="destructive" onClick={() => a.stop()}>Bitir</Button>}
        </div>}>
        <div className="max-h-[70vh] space-y-2 overflow-auto pr-1">
          {l.turns.map((t, i) => (
            <div key={i} className={cn("flex", t.role === "asena" ? "justify-start" : "justify-end")}>
              <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", t.role === "asena" ? "bg-primary/10" : "bg-amber-50 border")}>
                <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t.role === "asena" ? "Asena" : t.speaker ?? "Müşteri"} · {t.source}{t.masked ? " · maskelendi" : ""}</div>
                {t.text}
              </div>
            </div>
          ))}
          {l.speaking && <div className="text-xs text-muted-foreground">🔊 {l.speaking === "asena" ? "Asena konuşuyor…" : "Müşteri konuşuyor…"}</div>}
          {!l.outcome && !l.speaking && <div className="text-xs text-muted-foreground">… düşünüyor (anlama + karar)</div>}
        </div>
      </Box>
      <div className="space-y-4">
        <Box title="Kapasite"><Capacity /></Box>
        {l.guards.length > 0 && <Box title="Guardrail olayları">{l.guards.map((g, i) => <div key={i} className="mb-1 rounded border border-red-200 bg-red-50 p-2 text-xs"><b>{g.rf}</b> {g.reason}<div className="text-muted-foreground line-through">{g.original}</div></div>)}</Box>}
        <Box title="Araç çağrıları">
          <div className="max-h-56 space-y-1 overflow-auto text-xs">
            {l.tools.map((t, i) => <details key={i} className="rounded border p-1"><summary className="cursor-pointer font-mono">{t.name}</summary><pre className="whitespace-pre-wrap text-[10px]">{JSON.stringify({ args: t.args, result: t.result }, null, 1)}</pre></details>)}
          </div>
        </Box>
        <Box title="Karar akışı (bu görüşme)"><DecisionList items={decisions} /></Box>
      </div>
    </div>
  );
}

function DecisionList({ items }: { items: Decision[] }) {
  return (
    <div className="max-h-[60vh] space-y-1 overflow-auto text-xs">
      {items.map((d) => (
        <div key={d.id} className={cn("rounded border-l-4 bg-muted/40 px-2 py-1", d.seviye === "kritik" ? "border-red-500" : d.seviye === "uyari" ? "border-amber-400" : "border-zinc-300")}>
          <div className="flex gap-2"><span className="text-muted-foreground">{d.at.slice(11, 16)}</span><span className="font-medium">{d.actor}</span><span className="text-muted-foreground">{d.tip}</span>{d.ref?.map((r) => <span key={r} className="rounded bg-background px-1 text-[10px]">{r}</span>)}</div>
          <div>{d.ozet}</div>
          {d.gerekce && <div className="text-muted-foreground">↳ {d.gerekce}</div>}
        </div>
      ))}
    </div>
  );
}

// =====================================================================================
function Batch() {
  const a = useApp();
  const s = a.repo.settings();
  const cs = a.repo.customers();
  const [sel, setSel] = useState<string[]>(cs.map((c) => c.id));
  const preview = useMemo(() => a.order(sel, s.demo.strategy, s.demo.seed), [sel, s.demo.strategy, s.demo.seed, a.version]); // eslint-disable-line
  const run = a.batch;
  const missing = cs.filter((c) => sel.includes(c.id) && !c.karakter);
  const running = run?.status === "calisiyor";
  const runDecisions = run ? a.repo.decisions().filter((d) => d.runId === run.id).slice(-200).reverse() : [];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_460px]">
      <div className="space-y-4">
        <Box title="① Müşteriler ② Kurye yerleri ③ Karakterler ④ Sıra">
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            <Button size="xs" variant="outline" onClick={() => setSel(cs.map((c) => c.id))}>Hepsini seç</Button>
            <Button size="xs" variant="outline" onClick={() => { a.repo.saveCustomers(caseCustomers(a.repo.now())); a.repo.saveSlots(caseSlots(s.simulation.weekMonday)); a.repo.resetOperations(); setSel(caseCustomers(a.repo.now()).map((c) => c.id)); }}>Case setini yükle (8 müşteri + 5 slot, sabit karakterler)</Button>
            <select className="rounded border px-1" value={s.demo.difficulty} onChange={(e) => a.repo.patchSettings((x) => { x.demo.difficulty = e.target.value as never; })}><option value="kolay">kolay</option><option value="gercekci">gerçekçi</option><option value="zor">zor</option></select>
            <Input className="h-6 w-44 text-xs" value={s.demo.seed} onChange={(e) => a.repo.patchSettings((x) => { x.demo.seed = e.target.value; })} />
            <Button size="xs" variant="outline" onClick={() => assignCharacters(a.repo, sel, s.demo.seed, s.demo.difficulty, false)}>Rastgele ata (kilitliler hariç)</Button>
            <Button size="xs" variant="outline" onClick={() => assignCharacters(a.repo, sel, s.demo.seed, s.demo.difficulty, true)}>Tümüne zorla ata</Button>
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {cs.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
                <input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />
                <span className="font-medium">{c.adSoyad}</span><span className="text-muted-foreground">{c.adresler[0]?.ilce}</span>
                <span className="ml-auto truncate text-muted-foreground">{c.karakter ? `${c.karakter.arketipId}·${c.karakter.magduriyetId}·${c.karakter.musaitlikProfilId}${c.karakter.sapmaIds.length ? "·" + c.karakter.sapmaIds.join(",") : ""}` : "karakter yok"}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            Sıra stratejisi:
            <select className="rounded border px-1" value={s.demo.strategy} onChange={(e) => a.repo.patchSettings((x) => { x.demo.strategy = e.target.value as never; })}><option value="kitlik">Kıtlık önce</option><option value="liste">Liste sırası</option><option value="rastgele">Rastgele (seed)</option></select>
            Ses: <select className="rounded border px-1" value={s.listenMode} onChange={(e) => a.repo.patchSettings((x) => { x.listenMode = e.target.value as never; })}><option value="stream">sesli (stream)</option><option value="sessiz">sessiz-hızlı</option></select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={s.demo.stopAfterEach} onChange={(e) => a.repo.patchSettings((x) => { x.demo.stopAfterEach = e.target.checked; })} />her görüşmeden sonra dur</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={s.tts.phoneFilter} onChange={(e) => a.repo.patchSettings((x) => { x.tts.phoneFilter = e.target.checked; })} />telefon filtresi</label>
          </div>
          <div className="mt-2 rounded bg-muted p-2 text-xs"><b>Sıra önizlemesi:</b> {preview.order.map((id) => a.repo.customer(id)?.adSoyad.split(" ")[0]).join(" → ")}<div className="text-muted-foreground">{preview.why}</div></div>
          {missing.length > 0 && <div className="mt-2 text-xs text-red-600">Karakteri olmayan müşteriler: {missing.map((m) => m.adSoyad).join(", ")} — “Rastgele ata”ya basın.</div>}
          <div className="mt-3 flex gap-2">
            <Button disabled={running || missing.length > 0 || !sel.length} onClick={() => { audioCtx(); void a.runBatch(sel, s.demo.strategy, s.demo.seed, s.demo.stopAfterEach); }}>⑤ Çalıştır ({sel.length} müşteri)</Button>
            {run?.status === "duraklatildi" && <Button variant="outline" onClick={() => { audioCtx(); void a.continueBatch(s.demo.stopAfterEach); }}>Sonraki görüşme</Button>}
            {running && <Button variant="outline" onClick={() => a.togglePause()}>{a.pauseFlag ? "Devam" : "Duraklat"}</Button>}
            {running && <Button variant="destructive" onClick={() => a.stop()}>Durdur</Button>}
          </div>
        </Box>
        {run && (
          <Box title={`Parti zaman çizelgesi · ${run.status}`}>
            <div className="flex flex-wrap gap-2">
              {run.order.map((id, i) => {
                const r = run.results[id]; const c = a.repo.customer(id);
                const cur = i === run.cursor && running;
                return (
                  <div key={id + i} className={cn("w-40 rounded-lg border p-2 text-xs", cur && "border-primary ring-2 ring-primary/30")}>
                    <div className="font-medium">{i + 1}. {c?.adSoyad}</div>
                    <div>{cur ? "📞 sürüyor" : r?.skipped ? `⏭ atlandı` : r?.outcome ? <Status s={r.outcome} /> : "bekliyor"}</div>
                    {r?.slotId && <div className="text-muted-foreground">{r.slotId}</div>}
                    {r?.evaluation && <div>{r.evaluation.score === "ok" ? "✅" : r.evaluation.score === "uyari" ? "⚠️" : "❌"}</div>}
                    {r?.skipped && <div className="text-muted-foreground">{r.skipped}</div>}
                  </div>
                );
              })}
            </div>
            {run.status === "bitti" && <Report runId={run.id} />}
          </Box>
        )}
        {a.live && <Box title="Canlı görüşme (özet)"><MiniLive /></Box>}
        <Box title="Kapasite"><Capacity /></Box>
      </div>
      <Box title="Karar akışı (parti)"><DecisionList items={runDecisions} /></Box>
    </div>
  );
}

function MiniLive() {
  const l = useApp().live!;
  return (
    <div className="space-y-1 text-sm">
      <div className="text-xs text-muted-foreground">Durum: <b>{l.state}</b> {l.speaking && `· 🔊 ${l.speaking}`}</div>
      {l.turns.slice(-6).map((t, i) => <div key={i} className={t.role === "asena" ? "" : "text-right text-amber-800"}><b>{t.role === "asena" ? "Asena" : t.speaker ?? "Müşteri"}:</b> {t.text}</div>)}
    </div>
  );
}

function Report({ runId }: { runId: string }) {
  const a = useApp();
  const run = a.repo.runs().find((r) => r.id === runId)!;
  const vals = Object.values(run.results);
  const n = (o: string) => vals.filter((v) => v.outcome === o).length;
  const slots = a.repo.slots();
  const cap = slots.reduce((x, s) => x + s.kapasite, 0);
  const booked = a.repo.bookings().filter((b) => b.status === "aktif").length;
  const md = `# Asena toplu demo raporu\n\n${run.order.map((id, i) => `${i + 1}. ${a.repo.customer(id)?.adSoyad}: ${run.results[id]?.outcome ?? run.results[id]?.skipped ?? "-"} ${run.results[id]?.slotId ?? ""}`).join("\n")}\n`;
  return (
    <div className="mt-3 rounded-lg bg-muted p-3 text-sm">
      <b>⑥ Rapor:</b> {n("randevu_verildi")} randevu · {n("bekleme_listesi")} bekleme · {vals.filter((v) => v.skipped).length} atlandı · {vals.filter((v) => v.outcome && !["randevu_verildi", "bekleme_listesi"].includes(v.outcome)).length} diğer · doluluk {booked}/{cap} · kural ihlali {vals.filter((v) => v.evaluation?.score === "hata").length}
      <div className="mt-2 flex gap-2">
        <Button size="xs" variant="outline" onClick={() => download(`asena-rapor-${run.id}.md`, md)}>Markdown indir</Button>
        <Button size="xs" variant="outline" onClick={() => download(`asena-rapor-${run.id}.json`, JSON.stringify({ run, decisions: a.repo.decisions().filter((d) => d.runId === run.id) }, null, 1))}>JSON indir</Button>
      </div>
    </div>
  );
}

function download(name: string, text: string) {
  const u = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const el = document.createElement("a"); el.href = u; el.download = name; el.click(); URL.revokeObjectURL(u);
}

// =====================================================================================
function Customers({ onCall }: { onCall: (id: string) => void }) {
  const a = useApp();
  const { valid, invalid } = a.repo.customersAll();
  const lib = a.repo.characterLibrary();
  const [edit, setEdit] = useState<Customer | null>(null);
  const [bulk, setBulk] = useState("");
  const blank = (): Customer => ({ id: uid("M"), adSoyad: "", hitapEki: null, telefon: "", dogumTarihi: "1990-01-01", adresler: [{ id: uid("A"), tip: "Ev", ilce: "Kadıköy", dogrulanmis: true }], teslimAdresId: "", kart: { konum: "depoda", basarisizTeslim: 1 }, durum: "aranacak", createdAt: a.repo.now(), updatedAt: a.repo.now() });
  const fake = (n: number) => {
    const ad = ["Ali Dursun", "Deniz Koç", "Hakan Er", "Merve Tan", "Oya Kurt", "Emre Aksoy", "Gizem Polat", "Kerem Uçar"]; const il = ["Kadıköy", "Ataşehir", "Şişli", "Beşiktaş"];
    const all = a.repo.customers();
    for (let i = 0; i < n; i++) {
      const c = blank(); c.adSoyad = ad[(all.length + i) % ad.length]; c.telefon = normalizePhone(`0532 000 ${String(10 + all.length + i).padStart(2, "0")} ${String(i).padStart(2, "0")}`);
      c.adresler[0].ilce = il[i % il.length]; c.teslimAdresId = c.adresler[0].id; c.etiketler = ["sahte"]; c.dogumTarihi = `19${80 + i}-0${(i % 9) + 1}-1${i % 9}`;
      all.push(c);
    }
    a.repo.saveCustomers(all);
  };
  const importBulk = () => {
    const rows = bulk.trim().split("\n").map((r) => r.split(/[,;\t]/).map((x) => x.trim())).filter((r) => r.length >= 5 && !/ad_soyad/i.test(r[0]));
    const all = a.repo.customers();
    for (const [ad, tel, dob, ilce, tip] of rows) {
      const c = blank(); c.adSoyad = ad; c.telefon = normalizePhone(tel); c.dogumTarihi = dob; c.adresler[0] = { ...c.adresler[0], ilce, tip: /iş/i.test(tip) ? "İş yeri" : "Ev" }; c.teslimAdresId = c.adresler[0].id;
      all.push(c);
    }
    a.repo.saveCustomers(all); setBulk("");
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
      <Box title={`Müşteriler (${valid.length})`} right={<div className="flex gap-2"><Button size="xs" onClick={() => setEdit(blank())}>+ Müşteri ekle</Button><Button size="xs" variant="outline" onClick={() => fake(3)}>3 sahte müşteri üret</Button></div>}>
        {invalid.length > 0 && <div className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700">{invalid.length} bozuk kayıt görüşmeye alınmıyor: {invalid.map((x) => x.error).join(" | ")}</div>}
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th>Ad</th><th>Telefon</th><th>Adresler</th><th>Kart</th><th>Durum</th><th>Karakter</th><th /></tr></thead>
          <tbody>{valid.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="py-1.5 font-medium">{c.adSoyad} {c.etiketler?.includes("sahte") && <Badge variant="outline">sahte</Badge>}</td>
              <td className="text-xs">{c.telefon}</td>
              <td className="text-xs">{c.adresler.map((x) => <span key={x.id} className="mr-1 rounded bg-muted px-1">{x.ilce} · {x.tip}{x.dogrulanmis ? " ✓" : ""}</span>)}</td>
              <td className="text-xs">{c.kart.konum}</td>
              <td><Status s={c.durum} /></td>
              <td className="text-xs">{c.karakter ? lib.arketipler.find((x) => x.id === c.karakter!.arketipId)?.ad : "—"}</td>
              <td className="space-x-1 text-right"><Button size="xs" variant="outline" onClick={() => setEdit(structuredClone(c))}>Düzenle</Button><Button size="xs" onClick={() => onCall(c.id)} disabled={!a.svc.callGate(c.id).ok}>Ara</Button></td>
            </tr>))}
          </tbody>
        </table>
        <div className="mt-4 text-xs">
          <div className="mb-1 font-medium">Toplu giriş (CSV: ad_soyad, telefon, dogum_tarihi, ilce, adres_tipi)</div>
          <textarea className="h-20 w-full rounded border p-2 font-mono" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="Ali Dursun, 0532 000 00 99, 1991-05-04, Kadıköy, Ev" />
          <Button size="xs" className="mt-1" onClick={importBulk} disabled={!bulk.trim()}>İçe aktar</Button>
        </div>
      </Box>
      {edit && <CustomerEditor c={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CustomerEditor({ c: init, onClose }: { c: Customer; onClose: () => void }) {
  const a = useApp();
  const lib = a.repo.characterLibrary();
  const [c, setC] = useState<Customer>(init);
  const [err, setErr] = useState("");
  const k = c.karakter ?? { arketipId: "A12", magduriyetId: "G00", musaitlikProfilId: "P1", sapmaIds: [], seed: "elle", elleDuzenlendi: true };
  const setK = (p: Partial<typeof k>) => setC({ ...c, karakter: { ...k, ...p, elleDuzenlendi: true } });
  const save = () => {
    const x = { ...c, telefon: normalizePhone(c.telefon), teslimAdresId: c.adresler.some((ad) => ad.id === c.teslimAdresId) ? c.teslimAdresId : c.adresler[0].id };
    if (x.adSoyad.trim().split(/\s+/).length < 2) return setErr("Ad soyad girin");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.dogumTarihi)) return setErr("Doğum tarihi YYYY-AA-GG");
    a.repo.upsertCustomer(x); onClose();
  };
  const row = "grid grid-cols-[110px_1fr] items-center gap-2 text-xs";
  return (
    <Box title={init.adSoyad ? `Düzenle: ${init.adSoyad}` : "Yeni müşteri"} right={<Button size="xs" variant="ghost" onClick={onClose}>✕</Button>}>
      <div className="space-y-2">
        <div className={row}>Ad soyad<Input value={c.adSoyad} onChange={(e) => setC({ ...c, adSoyad: e.target.value })} /></div>
        <div className={row}>Hitap<select className="rounded border p-1" value={c.hitapEki ?? ""} onChange={(e) => setC({ ...c, hitapEki: (e.target.value || null) as never })}><option value="">(ad soyad)</option><option>Hanım</option><option>Bey</option></select></div>
        <div className={row}>Telefon<Input value={c.telefon} onChange={(e) => setC({ ...c, telefon: e.target.value })} placeholder="0532 000 00 00" /></div>
        <div className={row}>Doğum tarihi<Input type="date" value={c.dogumTarihi} onChange={(e) => setC({ ...c, dogumTarihi: e.target.value })} /></div>
        <div className="text-xs font-medium">Adresler (Asena açık adresi asla okumaz)</div>
        {c.adresler.map((ad, i) => (
          <div key={ad.id} className="flex items-center gap-1 text-xs">
            <input type="radio" checked={c.teslimAdresId === ad.id || (!c.teslimAdresId && i === 0)} onChange={() => setC({ ...c, teslimAdresId: ad.id })} title="Teslim adresi" />
            <select className="rounded border p-1" value={ad.tip} onChange={(e) => { const adr = [...c.adresler]; adr[i] = { ...ad, tip: e.target.value as never }; setC({ ...c, adresler: adr }); }}><option>Ev</option><option>İş yeri</option></select>
            <Input className="h-7" value={ad.ilce} onChange={(e) => { const adr = [...c.adresler]; adr[i] = { ...ad, ilce: e.target.value }; setC({ ...c, adresler: adr }); }} />
            <label className="flex items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={ad.dogrulanmis} onChange={(e) => { const adr = [...c.adresler]; adr[i] = { ...ad, dogrulanmis: e.target.checked }; setC({ ...c, adresler: adr }); }} />doğrulanmış</label>
            {c.adresler.length > 1 && <Button size="xs" variant="ghost" onClick={() => setC({ ...c, adresler: c.adresler.filter((x) => x.id !== ad.id) })}>✕</Button>}
          </div>
        ))}
        <Button size="xs" variant="outline" onClick={() => setC({ ...c, adresler: [...c.adresler, { id: uid("A"), tip: "İş yeri", ilce: "", dogrulanmis: true }] })}>+ adres</Button>
        <div className="pt-2 text-xs font-medium">Karakter (simüle müşteri)</div>
        <div className={row}>Arketip<select className="rounded border p-1" value={k.arketipId} onChange={(e) => setK({ arketipId: e.target.value })}>{lib.arketipler.map((x) => <option key={x.id} value={x.id}>{x.id} {x.ad}</option>)}</select></div>
        <div className={row}>Mağduriyet<select className="rounded border p-1" value={k.magduriyetId} onChange={(e) => setK({ magduriyetId: e.target.value })}>{lib.magduriyetler.map((x) => <option key={x.id} value={x.id}>{x.id} {x.ad}</option>)}</select></div>
        <div className={row}>Müsaitlik<select className="rounded border p-1" value={k.musaitlikProfilId} onChange={(e) => setK({ musaitlikProfilId: e.target.value })}>{lib.profiller.map((x) => <option key={x.id} value={x.id}>{x.id} {x.ad}</option>)}</select></div>
        <div className="text-xs">Sapmalar (0–2):</div>
        <div className="grid max-h-40 grid-cols-1 gap-0.5 overflow-auto text-[11px]">
          {lib.sapmalar.map((s) => <label key={s.id} className="flex gap-1"><input type="checkbox" checked={k.sapmaIds.includes(s.id)} onChange={(e) => setK({ sapmaIds: e.target.checked ? [...k.sapmaIds, s.id] : k.sapmaIds.filter((x) => x !== s.id) })} />{s.id} {s.ad}{s.sert_durdurma ? " 🛑" : ""}</label>)}
        </div>
        {CASE_VARIANTS[c.id] && <div className="flex flex-wrap gap-1 text-xs">Varyant: {CASE_VARIANTS[c.id].map((v) => <Button key={v.ad} size="xs" variant="outline" onClick={() => setK({ sapmaIds: v.sapmaIds })}>{v.ad}</Button>)}</div>}
        {err && <div className="text-xs text-red-600">{err}</div>}
        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={save}>Kaydet</Button>
          {a.repo.customer(init.id) && <Button size="sm" variant="destructive" onClick={() => { a.repo.deleteCustomer(init.id); onClose(); }}>Sil</Button>}
        </div>
      </div>
    </Box>
  );
}

// =====================================================================================
function Couriers() {
  const a = useApp();
  const s = a.repo.settings();
  const slots = a.repo.slots();
  const bookings = a.repo.bookings().filter((b) => b.status === "aktif");
  const [n, setN] = useState<CourierSlot>({ id: "", ilce: "Kadıköy", tarih: "2026-11-12", baslangic: "09:00", bitis: "13:00", kapasite: 1, aktif: true });
  const update = (id: string, p: Partial<CourierSlot>) => {
    const booked = bookings.filter((b) => b.slotId === id).length;
    if (p.kapasite !== undefined && p.kapasite < booked) { alert(`Kapasite mevcut randevu sayısının (${booked}) altına düşürülemez.`); return; }
    a.repo.saveSlots(slots.map((x) => (x.id === id ? { ...x, ...p } : x)));
  };
  const remove = (sl: CourierSlot) => {
    const affected = bookings.filter((b) => b.slotId === sl.id);
    if (affected.length && !confirm(`${affected.length} randevu etkilenecek; geri arama planı ve SMS oluşturulacak. Silinsin mi?`)) return;
    a.repo.saveBookings(a.repo.bookings().map((b) => (b.slotId === sl.id && b.status === "aktif" ? { ...b, status: "iptal", iptalNedeni: "slot silindi" } : b)));
    for (const b of affected) {
      a.svc.sendSms({ customerId: b.customerId }, b.customerId, "randevu_degisti", {});
      a.svc.plan(null, { customerId: b.customerId, type: "geri_arama", dueAt: a.repo.now(), channel: "ses", source: "operator", reason: `${sl.id} slotu silindi` });
      a.repo.updateCustomer(b.customerId, (c) => { c.durum = "geri_arama"; });
    }
    a.repo.saveSlots(slots.filter((x) => x.id !== sl.id));
  };
  const days = [...new Set(slots.map((x) => x.tarih))].sort();
  const districts = [...new Set(slots.map((x) => x.ilce))];
  return (
    <div className="grid gap-4">
      <Box title="Haftalık ızgara" right={<Button size="xs" variant="outline" onClick={() => a.repo.saveSlots(caseSlots(s.simulation.weekMonday))}>Case kurye yerlerini yükle</Button>}>
        <table className="w-full text-xs"><thead><tr><th className="text-left">İlçe</th>{days.map((d) => <th key={d} className="text-left">{fmtDateTr(d)}</th>)}</tr></thead>
          <tbody>{districts.map((dist) => <tr key={dist} className="border-t"><td className="py-1 font-medium">{dist}</td>{days.map((d) => <td key={d}>{slots.filter((x) => x.ilce === dist && x.tarih === d).map((x) => <div key={x.id} className="mb-1 rounded bg-muted px-1">{x.baslangic}–{x.bitis} · {bookings.filter((b) => b.slotId === x.id).length}/{x.kapasite}</div>)}</td>)}</tr>)}</tbody></table>
        <div className="mt-3"><Capacity /></div>
      </Box>
      <Box title="Kurye yerleri (düzenlenebilir — Asena bir sonraki araç çağrısında yeni değeri görür)">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground"><tr><th>ID</th><th>İlçe</th><th>Tarih</th><th>Başlangıç</th><th>Bitiş</th><th>Kapasite</th><th>Aktif</th><th>Doluluk</th><th /></tr></thead>
          <tbody>
            {slots.map((x) => (
              <tr key={x.id} className="border-t">
                <td className="font-mono">{x.id}</td>
                <td><Input className="h-7" value={x.ilce} onChange={(e) => update(x.id, { ilce: e.target.value })} /></td>
                <td><Input className="h-7" type="date" value={x.tarih} onChange={(e) => update(x.id, { tarih: e.target.value })} /></td>
                <td><Input className="h-7" type="time" value={x.baslangic} onChange={(e) => update(x.id, { baslangic: e.target.value })} /></td>
                <td><Input className="h-7" type="time" value={x.bitis} onChange={(e) => update(x.id, { bitis: e.target.value })} /></td>
                <td><Input className="h-7 w-16" type="number" min={1} value={x.kapasite} onChange={(e) => update(x.id, { kapasite: Number(e.target.value) })} /></td>
                <td><input type="checkbox" checked={x.aktif} onChange={(e) => update(x.id, { aktif: e.target.checked })} /></td>
                <td>{bookings.filter((b) => b.slotId === x.id).length}/{x.kapasite}</td>
                <td><Button size="xs" variant="ghost" onClick={() => remove(x)}>Sil</Button></td>
              </tr>
            ))}
            <tr className="border-t bg-muted/30">
              <td><Input className="h-7" placeholder="otomatik" value={n.id} onChange={(e) => setN({ ...n, id: e.target.value })} /></td>
              <td><Input className="h-7" value={n.ilce} onChange={(e) => setN({ ...n, ilce: e.target.value })} /></td>
              <td><Input className="h-7" type="date" value={n.tarih} onChange={(e) => setN({ ...n, tarih: e.target.value })} /></td>
              <td><Input className="h-7" type="time" value={n.baslangic} onChange={(e) => setN({ ...n, baslangic: e.target.value })} /></td>
              <td><Input className="h-7" type="time" value={n.bitis} onChange={(e) => setN({ ...n, bitis: e.target.value })} /></td>
              <td><Input className="h-7 w-16" type="number" min={1} value={n.kapasite} onChange={(e) => setN({ ...n, kapasite: Number(e.target.value) })} /></td>
              <td colSpan={3}><Button size="xs" onClick={() => { if (n.baslangic >= n.bitis) return alert("Başlangıç bitişten önce olmalı"); a.repo.saveSlots([...slots, { ...n, id: n.id || uid("SL") }]); }}>+ Ekle</Button></td>
            </tr>
          </tbody>
        </table>
      </Box>
    </div>
  );
}

// =====================================================================================
function Decisions() {
  const a = useApp();
  const [f, setF] = useState<"hepsi" | "kritik">("hepsi");
  const items = a.repo.decisions().filter((d) => f === "hepsi" || d.seviye !== "bilgi").slice(-400).reverse();
  return <Box title="Karar akışı (append-only audit, RF-23)" right={<select className="rounded border text-xs" value={f} onChange={(e) => setF(e.target.value as never)}><option value="hepsi">hepsi</option><option value="kritik">uyarı + kritik</option></select>}><DecisionList items={items} /></Box>;
}

function Outbox() {
  const a = useApp();
  const out = a.repo.outbox().slice().reverse();
  const cs = a.repo.customers();
  const [to, setTo] = useState(cs[0]?.id ?? "");
  const [body, setBody] = useState("");
  const byC = cs.map((c) => ({ c, msgs: out.filter((m) => m.customerId === c.id) })).filter((x) => x.msgs.length);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Box title={`Mesaj kutusu (${out.length} simüle SMS)`}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {byC.map(({ c, msgs }) => (
            <div key={c.id} className="rounded-2xl border-4 border-zinc-800 bg-zinc-50 p-3">
              <div className="mb-2 text-center text-xs font-semibold">{c.adSoyad} · {c.telefon}</div>
              <div className="max-h-72 space-y-2 overflow-auto">
                {msgs.slice().reverse().map((m) => <div key={m.id} className="rounded-xl bg-white p-2 text-xs shadow-sm"><div className="text-[10px] text-muted-foreground">{fmtShort(m.at)} · {m.template}</div>{m.body}</div>)}
              </div>
            </div>
          ))}
        </div>
      </Box>
      <Box title="Operatör SMS'i">
        <select className="mb-2 w-full rounded border p-1 text-sm" value={to} onChange={(e) => setTo(e.target.value)}>{cs.map((c) => <option key={c.id} value={c.id}>{c.adSoyad}</option>)}</select>
        <textarea className="h-24 w-full rounded border p-2 text-sm" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Ör. özür mesajı" />
        <Button size="sm" disabled={!body.trim()} onClick={() => { a.svc.sendSms(null, to, "operator", {}, undefined, body); setBody(""); }}>Gönder</Button>
      </Box>
    </div>
  );
}

function Plans() {
  const a = useApp();
  const now = isoToMs(a.repo.now());
  const all = a.repo.schedules().slice().sort((x, y) => isoToMs(x.dueAt) - isoToMs(y.dueAt));
  const due = all.filter((p) => p.status === "bekliyor" && isoToMs(p.dueAt) <= now);
  const cname = (id: string) => a.repo.customer(id)?.adSoyad ?? id;
  const setStatus = (id: string, status: "tamamlandi" | "iptal") => a.repo.saveSchedules(a.repo.schedules().map((p) => (p.id === id ? { ...p, status } : p)));
  return (
    <div className="grid gap-4">
      <Box title={`Şimdi aranmalı / yapılmalı (${due.length})`} right={<div className="flex gap-1">{[15, 60].map((m) => <Button key={m} size="xs" variant="outline" onClick={() => a.repo.patchSettings((s) => { s.simulation.now = msToIso(isoToMs(s.simulation.now) + m * 60_000); })}>+{m} dk</Button>)}</div>}>
        {due.map((p) => <div key={p.id} className={cn("mb-1 flex items-center gap-2 rounded border p-2 text-xs", p.type.startsWith("insan") || p.type.startsWith("guvenlik") ? "border-red-300 bg-red-50" : "")}><b>{cname(p.customerId)}</b>{p.type} · {p.reason}{p.slaDeadline && ` · SLA ${fmtShort(p.slaDeadline)}`}<div className="ml-auto flex gap-1">{p.channel === "ses" && <Button size="xs" onClick={() => { audioCtx(); setStatus(p.id, "tamamlandi"); void a.startCall(p.customerId); }}>Şimdi ara</Button>}<Button size="xs" variant="outline" onClick={() => setStatus(p.id, "tamamlandi")}>Tamamlandı</Button></div></div>)}
        {!due.length && <div className="text-xs text-muted-foreground">Zamanı gelen plan yok.</div>}
      </Box>
      <Box title="Tüm planlar">
        <table className="w-full text-xs"><thead className="text-left text-muted-foreground"><tr><th>Zaman</th><th>Müşteri</th><th>Tip</th><th>Kanal</th><th>Durum</th><th>Neden</th><th /></tr></thead>
          <tbody>{all.map((p) => <tr key={p.id} className="border-t"><td className="py-1">{fmtShort(p.dueAt)}{p.uyari && " ⚠️"}</td><td>{cname(p.customerId)}</td><td>{p.type}</td><td>{p.channel}</td><td>{p.status === "bekliyor" && isoToMs(p.slaDeadline ?? p.dueAt) + 30 * 60_000 < now ? "gecikti" : p.status}</td><td>{p.reason}</td><td>{p.status === "bekliyor" && <Button size="xs" variant="ghost" onClick={() => setStatus(p.id, "iptal")}>iptal</Button>}</td></tr>)}</tbody></table>
      </Box>
      <Box title="Notlar">
        <div className="space-y-1 text-xs">{a.repo.notes().slice().reverse().map((n) => <div key={n.id} className="rounded border p-1"><b>{cname(n.customerId)}</b> · {n.category} · {n.visibility === "asena" ? "👁 Asena" : n.visibility === "courier" ? "🛵 kurye" : "🔒 iç"} · {n.text}</div>)}</div>
      </Box>
    </div>
  );
}

function Kb() {
  const a = useApp();
  const docs = a.repo.kb();
  const [md, setMd] = useState(docs[0]?.markdown ?? "");
  const parsed = parseKb([{ id: "x", title: "", markdown: md, active: true, updatedAt: "" }]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Box title="Kurum bilgisi (markdown)" right={<Button size="xs" onClick={() => a.repo.saveKb([{ ...docs[0], markdown: md, updatedAt: a.repo.now() }])}>Kaydet</Button>}>
        <div className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-900">Kurum bilgisi yasal kuralları geçersiz kılamaz. Çelişki olursa Asena yasal kuralı uygular.</div>
        <textarea className="h-[60vh] w-full rounded border p-2 font-mono text-xs" value={md} onChange={(e) => setMd(e.target.value)} />
      </Box>
      <Box title="Asena'nın gördüğü">
        {parsed.warnings.map((w) => <div key={w} className="mb-1 rounded bg-red-50 p-1 text-xs text-red-700">⚠️ {w}</div>)}
        <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(parsed, null, 1)}</pre>
      </Box>
    </div>
  );
}

function SettingsView({ h, onRetry }: { h: Health | { error: string } | null; onRetry: () => void }) {
  const a = useApp();
  const s = a.repo.settings();
  const models = h && !("error" in h) ? h.llm?.models ?? [] : ["alibayram/kumru:latest", "qwen3:4b"];
  const [tok, setTok] = useState("");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Box title="Yerel motor" right={<Button size="xs" variant="outline" onClick={onRetry}>Yeniden tara</Button>}>
        <div className="space-y-2 text-xs">
          <div>Adres: <Input className="h-7" value={s.engine.url} onChange={(e) => a.repo.patchSettings((x) => { x.engine.url = e.target.value; })} /></div>
          <div>Eşleşme: <b>{s.engine.token ? "token kayıtlı" : "eşleşmemiş"}</b></div>
          {(!h || "error" in h) && <div className="rounded bg-amber-50 p-2">Yerel motor bulunamadı. Terminalde çalıştırın:<pre className="mt-1 rounded bg-zinc-900 p-2 text-zinc-100">cd ~/Desktop/Asena/engine && uv run asena-engine</pre>Canlı sitedeyseniz Chrome'un yerel ağ erişim iznini kontrol edin (chrome://settings/content → bu site → Yerel ağ erişimi: İzin ver) ve <code>ASENA_ALLOWED_ORIGINS</code>'e <code>{origin}</code> ekleyin.</div>}
          {h && !("error" in h) && !h.paired && <div className="rounded bg-amber-50 p-2">Motoru eşleştirin: terminaldeki <code>{origin}/eslestir#t=…</code> bağlantısını açın ya da token'ı yapıştırın (<code>cat ~/.asena/token</code>):<div className="mt-1 flex gap-1"><Input className="h-7" value={tok} onChange={(e) => setTok(e.target.value)} /><Button size="xs" onClick={() => { a.repo.patchSettings((x) => { x.engine.token = tok.trim(); }); onRetry(); }}>Kaydet</Button></div></div>}
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2">{JSON.stringify(h, null, 1)}</pre>
        </div>
      </Box>
      <Box title="Modeller ve davranış">
        <div className="space-y-2 text-xs">
          {(["anlama", "konusma", "musteri"] as const).map((r) => <div key={r} className="flex items-center gap-2"><span className="w-20">{r}</span><select className="rounded border p-1" value={s.llm[r]} onChange={(e) => a.repo.patchSettings((x) => { x.llm[r] = e.target.value; })}>{models.map((m) => <option key={m}>{m}</option>)}</select></div>)}
          <label className="flex gap-2"><input type="checkbox" checked={s.llm.speech === "llm"} onChange={(e) => a.repo.patchSettings((x) => { x.llm.speech = e.target.checked ? "llm" : "sablon"; })} />Asena empati cümlelerini Kumru üretsin (guardrail'li; aksi halde şablon)</label>
          <label className="flex gap-2"><input type="checkbox" checked={s.llm.customer === "llm"} onChange={(e) => a.repo.patchSettings((x) => { x.llm.customer = e.target.checked ? "llm" : "senaryo"; })} />Simüle müşteri cümlelerini Kumru yeniden söylesin (kritik cümleler senaryodan)</label>
          <div className="flex items-center gap-2"><span className="w-20">Asena sesi</span><select className="rounded border p-1" value={s.tts.asena} onChange={(e) => a.repo.patchSettings((x) => { x.tts.asena = e.target.value as never; })}><option value="ema">EMA Lightning</option><option value="antalia">Antalia-2 Mini</option></select></div>
          <div className="flex items-center gap-2"><span className="w-20">Müşteri sesi</span><select className="rounded border p-1" value={s.tts.musteri} onChange={(e) => a.repo.patchSettings((x) => { x.tts.musteri = e.target.value as never; })}><option value="antalia">Antalia-2 Mini</option><option value="ema">EMA Lightning</option></select></div>
          <div className="flex items-center gap-2"><span className="w-20">Dinleme</span><select className="rounded border p-1" value={s.listenMode} onChange={(e) => a.repo.patchSettings((x) => { x.listenMode = e.target.value as never; })}><option value="stream">stream (sesli)</option><option value="sessiz">sessiz-hızlı</option></select></div>
          <label className="flex gap-2"><input type="checkbox" checked={s.tts.phoneFilter} onChange={(e) => a.repo.patchSettings((x) => { x.tts.phoneFilter = e.target.checked; })} />Telefon filtresi (300–3400 Hz)</label>
          <div className="flex items-center gap-2"><span className="w-20">Maks. tur</span><Input className="h-7 w-20" type="number" value={s.behavior.maxTurns} onChange={(e) => a.repo.patchSettings((x) => { x.behavior.maxTurns = Number(e.target.value); })} /></div>
          <div>Uyum: demo_only doğrulama (sabit açık) · maskeleme açık (kapatılamaz)</div>
          <div className="flex items-center gap-2"><span className="w-20">Sim. saati</span><Input className="h-7" value={s.simulation.now} onChange={(e) => a.repo.patchSettings((x) => { x.simulation.now = e.target.value; })} /></div>
        </div>
      </Box>
      <Box title="Veri">
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => download("asena-veri.json", JSON.stringify(a.repo.exportAll(), null, 1))}>Dışa aktar (JSON)</Button>
          <label className="cursor-pointer rounded border px-2 py-1 text-xs">İçe aktar<input type="file" className="hidden" accept=".json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) a.repo.importAll(JSON.parse(await f.text())); }} /></label>
        </div>
      </Box>
    </div>
  );
}
