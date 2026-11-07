"use client";
// Uygulama kontrolcüsü (tarayıcı): depo, servis, görüşme ve toplu demo yürütücüsü.
import { useSyncExternalStore } from "react";
import { LocalStorageKV } from "./store/kv";
import { Repo, uid, type Key } from "./store/repo";
import { browserLock, DeliveryService } from "./service/delivery";
import { AsenaCall, type CallEvent, type CallState } from "./orchestrator/call";
import { availability } from "./orchestrator/customer";
import { speak as playTts, stopAudio } from "./audio/player";
import { isoToMs, msToIso } from "./domain/time";
import { sameDistrict } from "./domain/schemas";
import type { Customer, Evaluation, Outcome, Run, RunStrategy } from "./domain/types";
import { parseKb } from "./domain/kb";

export type LiveTurn = { role: "asena" | "musteri"; text: string; speaker?: string; source?: string; masked?: boolean };
export type Live = {
  callId: string; customerId: string; state: CallState; history: CallState[]; turns: LiveTurn[];
  tools: { name: string; args: unknown; result: unknown }[]; guards: { rf: string; reason: string; original: string; replaced: string }[];
  understanding: unknown[]; outcome?: Outcome; summary?: string; speaking?: "asena" | "musteri" | null; evaluation?: Evaluation;
};

class Controller {
  repo: Repo; svc: DeliveryService;
  version = 0;
  live: Live | null = null;
  batch: Run | null = null;
  stopFlag = false;
  pauseFlag = false;
  listeners = new Set<() => void>();
  bc: BroadcastChannel | null = null;

  constructor() {
    this.repo = new Repo(new LocalStorageKV(), (keys) => this.changed(keys, true));
    this.svc = new DeliveryService(this.repo, browserLock);
    if (typeof window !== "undefined") {
      this.repo.ensureSeeded();
      try {
        this.bc = new BroadcastChannel("asena");
        this.bc.onmessage = () => this.changed([], false);
      } catch { /* yok */ }
    }
  }
  changed(_keys: Key[] | string[], broadcast: boolean) {
    this.version++;
    if (broadcast) this.bc?.postMessage({ v: this.version });
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  snapshot = () => this.version;

  engineConf() {
    const s = this.repo.settings();
    return s.engine.token ? s.engine : null;
  }

  // ------------------------------------------------------------------ tek görüşme
  async startCall(customerId: string, runId?: string): Promise<{ outcome: Outcome | null; callId?: string; skipped?: string }> {
    if (this.live && !this.live.outcome) return { outcome: null, skipped: "Başka görüşme sürüyor" };
    const callId = uid("C");
    const opened = this.svc.openSession(callId, customerId, { runId });
    if (!opened.ok) {
      this.svc.decide({ customerId, runId }, { actor: "sistem", tip: "atlandi", ozet: `${this.repo.customer(customerId)?.adSoyad ?? customerId} aranmadı`, gerekce: opened.reason, ref: [opened.ref], seviye: "uyari" });
      return { outcome: null, skipped: opened.reason };
    }
    const settings = this.repo.settings();
    const kb = parseKb(this.repo.kb());
    if (kb.flags.on_bilgi_sms) this.svc.sendSms({ callId, customerId, runId }, customerId, "on_bilgi", {});
    this.stopFlag = false;
    this.live = { callId, customerId, state: "ACILIS", history: ["ACILIS"], turns: [], tools: [], guards: [], understanding: [], speaking: null };
    this.changed([], false);
    const engine = this.engineConf();
    const lib = this.repo.characterLibrary();
    const call = new AsenaCall(callId, customerId, {
      svc: this.svc, engine, lib,
      models: { anlama: settings.llm.anlama, konusma: settings.llm.konusma, musteri: settings.llm.musteri },
      useLlmSpeech: settings.llm.speech === "llm", useLlmCustomer: settings.llm.customer === "llm",
      maxTurns: settings.behavior.maxTurns,
      stopped: () => this.stopFlag,
      emit: (e) => this.onEvent(e),
      speak: async (role, text, c) => this.speak(role, text, c),
    });
    try {
      await call.run();
    } catch (e) {
      console.error(e);
      this.live.summary = "Hata: " + String(e);
    }
    // simülasyon saati: görüşme başına +3 dk
    this.repo.patchSettings((s) => { s.simulation.now = msToIso(isoToMs(s.simulation.now) + 3 * 60_000); });
    const ev = this.evaluate(customerId, callId, call.outcome);
    const rec = this.repo.calls().find((c) => c.id === callId);
    if (rec) this.repo.upsertCall({ ...rec, turns: call.turns, evaluation: ev });
    this.svc.decide({ callId, customerId, runId }, { actor: "sistem", tip: "degerlendirme", ozet: `Değerlendirme: ${ev.score === "ok" ? "✅" : ev.score === "uyari" ? "⚠️" : "❌"} ${ev.checks.filter((c) => c.status !== "ok").map((c) => c.label).join(", ") || "sorun yok"}`, gerekce: ev.checks.map((c) => `${c.label}: ${c.detail}`).join(" · "), seviye: ev.score === "hata" ? "kritik" : ev.score === "uyari" ? "uyari" : "bilgi" });
    if (this.live) { this.live.evaluation = ev; this.live.speaking = null; }
    this.changed([], false);
    return { outcome: call.outcome, callId };
  }

  async speak(role: "asena" | "musteri", text: string, c: Customer) {
    if (!this.live) return;
    this.live.speaking = role; this.changed([], false);
    const s = this.repo.settings();
    const engine = this.engineConf();
    const ark = this.repo.characterLibrary().arketipler.find((a) => a.id === c.karakter?.arketipId);
    try {
      if (s.listenMode === "stream" && engine) {
        await playTts(engine, role === "asena" ? s.tts.asena : s.tts.musteri, text.replace(/\[[^\]]*\]/g, "").slice(0, 400) || "…", {
          rate: role === "asena" ? s.tts.rate : ark?.ses.rate ?? 1, pitch: role === "musteri" && s.tts.pitchVariety ? ark?.ses.pitch ?? 1 : 1, phone: s.tts.phoneFilter,
        });
        await new Promise((r) => setTimeout(r, s.behavior.turnGapMs));
      } else {
        await new Promise((r) => setTimeout(r, s.listenMode === "sessiz" ? 60 : 350));
      }
    } catch (e) {
      console.warn("TTS hatası, sessiz devam", e);
      await new Promise((r) => setTimeout(r, 300));
    }
    while (this.pauseFlag && !this.stopFlag) await new Promise((r) => setTimeout(r, 200));
    if (this.live) this.live.speaking = null;
  }

  onEvent(e: CallEvent) {
    const l = this.live; if (!l) return;
    if (e.type === "state") { l.state = e.to; l.history.push(e.to); }
    if (e.type === "turn") l.turns.push({ role: e.role, text: e.text, speaker: e.speaker, source: e.source, masked: e.masked });
    if (e.type === "tool") l.tools.push({ name: e.name, args: e.args, result: e.result });
    if (e.type === "guardrail") l.guards.push(e);
    if (e.type === "understanding") l.understanding.push(e);
    if (e.type === "end") { l.outcome = e.outcome; l.summary = e.summary; }
    this.changed([], false);
  }

  stop() { this.stopFlag = true; stopAudio(); if (this.batch) { this.batch.status = "durduruldu"; this.repo.upsertRun(this.batch); } this.changed([], false); }
  togglePause() { this.pauseFlag = !this.pauseFlag; this.changed([], false); }

  // ------------------------------------------------------------------ değerlendirme
  evaluate(customerId: string, callId: string, outcome: Outcome | null): Evaluation {
    const c = this.repo.customer(customerId);
    const lib = this.repo.characterLibrary();
    const checks: Evaluation["checks"] = [];
    const booking = this.repo.bookings().find((b) => b.callId === callId && b.status === "aktif");
    const sap = lib.sapmalar.filter((s) => c?.karakter?.sapmaIds.includes(s.id));
    const hard = sap.find((s) => s.sert_durdurma);
    if (hard) checks.push({ id: "hard", label: "Sert durdurma", status: !booking && !!this.repo.flags(customerId).teslimat_donduruldu ? "ok" : "hata", detail: `${hard.ref}: randevu ${booking ? "VERİLDİ" : "yok"}, dondurma ${this.repo.flags(customerId).teslimat_donduruldu ? "var" : "yok"}`, ref: hard.ref });
    if (booking) {
      const slot = this.repo.slots().find((s) => s.id === booking.slotId);
      const prof = lib.profiller.find((p) => p.id === c?.karakter?.musaitlikProfilId);
      const a = slot ? availability(prof, slot) : { kind: "kabul" as const };
      checks.push({ id: "fit", label: "Müsaitlik uyumu", status: a.kind === "kabul" ? "ok" : a.kind === "kismi" ? "uyari" : "hata", detail: a.kind === "kabul" ? "Slot müşterinin gerçek müsaitliğine uyuyor" : `Uyumsuz slota randevu (${a.kind}) — ikinci boşa giden kurye riski` });
    }
    const guards = this.live?.guards.length ?? 0;
    checks.push({ id: "guard", label: "Guardrail müdahalesi", status: guards ? "uyari" : "ok", detail: guards ? `${guards} cümle engellendi/değiştirildi (müşteriye ulaşmadı)` : "Yok" });
    const mag = lib.magduriyetler.find((m) => m.id === c?.karakter?.magduriyetId);
    if (mag && mag.yogunluk >= 2 && this.live?.turns.length) {
      const logged = this.live.tools.some((t) => t.name === "log_complaint");
      checks.push({ id: "complaint", label: "Şikayet kaydı", status: logged ? "ok" : "uyari", detail: logged ? "log_complaint çağrıldı" : "Mağduriyet vardı, şikayet kaydı yok" });
    }
    checks.push({ id: "outcome", label: "Sonuç", status: outcome ? "ok" : "uyari", detail: outcome ?? "sonuç yok" });
    const score = checks.some((x) => x.status === "hata") ? "hata" : checks.some((x) => x.status === "uyari" && x.id !== "guard") ? "uyari" : "ok";
    return { score, checks };
  }

  // ------------------------------------------------------------------ toplu demo
  order(ids: string[], strategy: RunStrategy, seed: string): { order: string[]; why: string } {
    const cs = ids.map((id) => this.repo.customer(id)).filter(Boolean) as Customer[];
    if (strategy === "liste") return { order: cs.map((c) => c.id), why: "Liste sırası (operatör)" };
    if (strategy === "rastgele") {
      let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const arr = [...cs]; for (let i = arr.length - 1; i > 0; i--) { h = (h * 1103515245 + 12345) >>> 0; const j = h % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return { order: arr.map((c) => c.id), why: `Rastgele (seed: ${seed})` };
    }
    const slots = this.repo.slots();
    const ilce = (c: Customer) => c.adresler.find((a) => a.id === c.teslimAdresId)?.ilce ?? "";
    const meta = cs.map((c, i) => {
      const d = ilce(c);
      const demand = cs.filter((x) => sameDistrict(ilce(x), d)).length;
      const cap = slots.filter((s) => sameDistrict(s.ilce, d) && s.aktif).reduce((a, s) => a + s.kapasite, 0) || 0.5;
      return { c, i, opt: this.svc.optionsFor(c), press: demand / cap, demand, d };
    });
    meta.sort((a, b) => a.opt - b.opt || b.press - a.press || a.demand - b.demand || a.i - b.i);
    const groups = [...new Set(meta.map((m) => `${m.d}: ${m.opt} seçenek, ${m.demand} müşteri`))];
    return { order: meta.map((m) => m.c.id), why: `Kıtlık önce (K-10): ${groups.join(" · ")}` };
  }

  async runBatch(ids: string[], strategy: RunStrategy, seed: string, stopAfterEach: boolean) {
    const { order, why } = this.order(ids, strategy, seed);
    const run: Run = { id: uid("R"), createdAt: this.repo.now(), seed, strategy, customerIds: ids, order, cursor: 0, status: "calisiyor", difficulty: this.repo.settings().demo.difficulty, callIds: {}, results: {} };
    this.batch = run; this.repo.upsertRun(run);
    const names = order.map((id) => this.repo.customer(id)?.adSoyad.split(" ")[0]).join(", ");
    this.svc.decide({ runId: run.id }, { actor: "sistem", tip: "arama_sirasi", ozet: `Sıra: ${names}`, gerekce: why, ref: ["K-10", "V-29"], seviye: "bilgi" });
    await this.continueBatch(stopAfterEach);
  }

  async continueBatch(stopAfterEach: boolean) {
    const run = this.batch; if (!run) return;
    run.status = "calisiyor"; this.stopFlag = false;
    while (run.cursor < run.order.length && !this.stopFlag) {
      const id = run.order[run.cursor];
      const r = await this.startCall(id, run.id);
      run.results[id] = { outcome: r.outcome ?? undefined, skipped: r.skipped, slotId: this.repo.bookings().find((b) => b.customerId === id && b.status === "aktif")?.slotId, evaluation: this.live?.evaluation };
      if (r.callId) run.callIds[id] = r.callId;
      run.cursor++;
      // K-24: boşalan yer → bekleme listesindeki müşteri partinin sonuna
      for (const p of this.repo.schedules().filter((p) => p.type === "bekleme_listesi_arama" && p.status === "bekliyor")) {
        if (!run.order.slice(run.cursor).includes(p.customerId)) {
          run.order.push(p.customerId);
          this.repo.saveSchedules(this.repo.schedules().map((x) => (x.id === p.id ? { ...x, status: "tamamlandi" } : x)));
          this.svc.decide({ runId: run.id, customerId: p.customerId }, { actor: "sistem", tip: "sira_guncellendi", ozet: `${this.repo.customer(p.customerId)?.adSoyad} partinin sonuna eklendi`, gerekce: "Bir yer boşaldı (K-24)", ref: ["K-24", "EC-54"], seviye: "bilgi" });
        }
      }
      this.repo.upsertRun(run); this.changed([], false);
      if (stopAfterEach && run.cursor < run.order.length) { run.status = "duraklatildi"; this.repo.upsertRun(run); this.changed([], false); return; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (run.cursor >= run.order.length) {
      run.status = "bitti"; run.finishedAt = this.repo.now();
      const vals = Object.values(run.results);
      const n = (o: string) => vals.filter((v) => v.outcome === o).length;
      this.svc.decide({ runId: run.id }, { actor: "sistem", tip: "degerlendirme", ozet: `Parti bitti: ${n("randevu_verildi")} randevu · ${n("bekleme_listesi")} bekleme · ${vals.filter((v) => v.skipped).length} atlandı · ${vals.filter((v) => v.evaluation?.score === "hata").length} kural ihlali`, gerekce: "Toplu demo özeti", seviye: "bilgi" });
    }
    this.repo.upsertRun(run); this.changed([], false);
  }
}

let ctrl: Controller | null = null;
export function app(): Controller {
  if (!ctrl) ctrl = new Controller();
  return ctrl;
}

/** Depo değişince yeniden çizer. */
export function useApp() {
  const c = app();
  useSyncExternalStore(c.subscribe, c.snapshot, () => 0);
  return c;
}
