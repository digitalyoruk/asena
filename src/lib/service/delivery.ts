// Teslimat servisi = Asena'nın araçları (asena/arac-tanimlari.md). Tarayıcıda, localStorage üzerinde çalışır.
// Oturum bağlamı (müşteri, ilçe) örtüktür; LLM'den parametre alınmaz (RF-09). 🔒 araçlar doğrulama ister.
import { parseKb, type KbConfig } from "../domain/kb";
import { sameDistrict } from "../domain/schemas";
import { spokenSlot } from "../domain/spoken";
import {
  addDays, inCallHours, isoToMs, localToMs, msToIso, nextCallableMs, parts, slotCutoffMs, slotStartMs,
} from "../domain/time";
import type {
  Booking, CourierSlot, Customer, Decision, FreezeReason, Hold, NoteCategory, NoteVisibility, Outcome, Schedule,
  ScheduleType, SmsTemplate,
} from "../domain/types";
import { checkNote, maskInput } from "../orchestrator/guardrails";
import { Repo, uid } from "../store/repo";
import { renderSms, type SmsVars } from "./sms";

export const HOLD_TTL_S = 180; // K-04

export type ToolOk<T = Record<string, unknown>> = { ok: true } & T;
export type ToolErr = { ok: false; error: string; message: string; [k: string]: unknown };
export type ToolResult<T = Record<string, unknown>> = ToolOk<T> | ToolErr;

export type Session = {
  callId: string; customerId: string; runId?: string; verified: boolean; verifyAttempts: number;
  yon: "giden" | "gelen"; startedAt: string;
};

export type SlotView = {
  slot_id: string; gun: string; tarih: string; baslangic: string; bitis: string; bos_yer: number; sozlu: string; adres_tipi: string; ilce: string;
};

export type LockFn = <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
export const noLock: LockFn = async (_n, fn) => fn();
export const browserLock: LockFn = async (name, fn) => {
  if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request(name, async () => fn());
  return fn();
};

const err = (error: string, message: string, extra: Record<string, unknown> = {}): ToolErr => ({ ok: false, error, message, ...extra });

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

export function hitapOf(c: Pick<Customer, "adSoyad" | "hitapEki">) {
  const first = c.adSoyad.split(/\s+/)[0];
  return c.hitapEki ? `${first} ${c.hitapEki}` : c.adSoyad;
}

/** Arama başlatma ön kontrolü (POST /api/calls karşılığı). */
export type CallGate = { ok: true } | { ok: false; code: 409 | 429 | 425; reason: string; ref: string };

export class DeliveryService {
  sessions = new Map<string, Session>();
  wallNow: () => number;
  constructor(public repo: Repo, public lock: LockFn = noLock, opts: { wallNow?: () => number } = {}) {
    this.wallNow = opts.wallNow ?? (() => Date.now());
  }

  kb(): KbConfig { return parseKb(this.repo.kb()); }
  now() { return this.repo.now(); }
  nowMs() { return isoToMs(this.now()); }

  decide(s: Partial<Session> | null, d: Omit<Decision, "id" | "seq" | "at" | "callId" | "customerId" | "runId"> & { customerId?: string }): Decision {
    return this.repo.appendDecision({ ...d, callId: s?.callId, customerId: d.customerId ?? s?.customerId, runId: s?.runId });
  }

  // ------------------------------------------------------------------ yardımcı hesaplar
  freeCount(slot: CourierSlot, exceptHoldOfCall?: string): number {
    const now = this.wallNow();
    const booked = this.repo.bookings().filter((b) => b.slotId === slot.id && b.status === "aktif").length;
    const held = this.repo.holds().filter((h) => h.slotId === slot.id && h.expiresAt > now && h.callId !== exceptHoldOfCall).length;
    return Math.max(0, slot.kapasite - booked - held);
  }
  slotOpen(slot: CourierSlot) { return slot.aktif && slotCutoffMs(slot) > this.nowMs(); }
  verifiedAddresses(c: Customer) { return c.adresler.filter((a) => a.dogrulanmis); }
  activeBooking(customerId: string) { return this.repo.bookings().find((b) => b.customerId === customerId && b.status === "aktif"); }

  /** Kıtlık önce sırası için: müşterinin seçenek sayısı (doğrulanmış ilçelerdeki açık slotlar). */
  optionsFor(c: Customer): number {
    const ilceler = this.verifiedAddresses(c).map((a) => a.ilce);
    return this.repo.slots().filter((s) => ilceler.some((i) => sameDistrict(i, s.ilce)) && this.slotOpen(s) && this.freeCount(s) > 0).length;
  }

  // ------------------------------------------------------------------ arama kapısı
  callGate(customerId: string): CallGate {
    const c = this.repo.customer(customerId);
    if (!c) return { ok: false, code: 409, reason: "Müşteri kaydı geçersiz veya yok", ref: "dinamik-veri §1.4" };
    const f = this.repo.flags(customerId);
    if (f.aranmasin) return { ok: false, code: 409, reason: "Aranmasın bayrağı var", ref: "RF-30" };
    if (f.teslimat_donduruldu) return { ok: false, code: 409, reason: "Teslimat donduruldu", ref: "K-25" };
    if (f.numara_gecersiz) return { ok: false, code: 409, reason: "Numara geçersiz", ref: "EC-11" };
    if (f.iletisim_kanali === "yazili") return { ok: false, code: 409, reason: "Müşteri yazılı kanal tercih ediyor", ref: "EC-15" };
    if (this.activeBooking(customerId)) return { ok: false, code: 409, reason: "Aktif randevusu var (çift arama)", ref: "EC-91" };
    const now = this.nowMs();
    if (!inCallHours(now)) return { ok: false, code: 425, reason: "Arama saatleri dışında (Pzt–Cmt 09–20)", ref: "K-11" };
    const today = parts(now).date;
    const todays = this.repo.attempts().filter((a) => a.customerId === customerId && a.yon === "giden" && parts(isoToMs(a.at)).date === today);
    if (todays.length >= 3) return { ok: false, code: 429, reason: "Bugün 3 deneme yapıldı", ref: "K-11" };
    const last = todays.sort((a, b) => isoToMs(b.at) - isoToMs(a.at))[0];
    if (last && now - isoToMs(last.at) < 2 * 3600_000) return { ok: false, code: 429, reason: "Son denemeden bu yana 2 saat geçmedi", ref: "K-11" };
    return { ok: true };
  }

  openSession(callId: string, customerId: string, opts: { runId?: string; yon?: "giden" | "gelen"; skipGate?: boolean } = {}) {
    if (!opts.skipGate) {
      const g = this.callGate(customerId);
      if (!g.ok) return g;
    }
    const c = this.repo.customer(customerId)!;
    const s: Session = { callId, customerId, runId: opts.runId, verified: false, verifyAttempts: 0, yon: opts.yon ?? "giden", startedAt: this.now() };
    this.sessions.set(callId, s);
    this.repo.updateCustomer(customerId, (x) => { x.durum = "aranıyor"; });
    this.repo.upsertCall({ id: callId, customerId, runId: opts.runId, startedAt: this.now(), turns: 0, yon: s.yon });
    // Doğrulama öncesi Asena'ya yalnız ad-soyad ve hitap (musteri-notlari §4)
    return { ok: true as const, public: { adSoyad: c.adSoyad, hitap: hitapOf(c) } };
  }

  private s(callId: string): Session {
    const s = this.sessions.get(callId);
    if (!s) throw new Error("Oturum yok: " + callId);
    return s;
  }
  private gate(s: Session): ToolErr | null {
    return s.verified ? null : err("ERR_NOT_VERIFIED", "Müşteri doğrulanmadan bu araç kullanılamaz.");
  }

  // ------------------------------------------------------------------ araçlar
  verify_identity(callId: string, a: { spoken_birth_date: string | null; reason?: string }): ToolResult<{ verified: boolean; attempts_left?: number; action?: string }> {
    const s = this.s(callId);
    const c = this.repo.customer(s.customerId)!;
    if (s.verified) return { ok: true, verified: true };
    const match = !!a.spoken_birth_date && a.spoken_birth_date === c.dogumTarihi;
    if (match) {
      s.verified = true;
      this.decide(s, { actor: "asena", tip: "dogrulama", ozet: "Doğrulama başarılı (demo_only)", gerekce: "Söylenen tarih kayıtla eşleşti (değer loglanmaz)", ref: ["V-01", "RF-02", "RF-04"], seviye: "bilgi" });
      return { ok: true, verified: true };
    }
    s.verifyAttempts++;
    const left = Math.max(0, 2 - s.verifyAttempts);
    this.decide(s, { actor: "asena", tip: "dogrulama", ozet: `Doğrulama başarısız (${s.verifyAttempts}/2)`, gerekce: a.spoken_birth_date ? "Söylenen tarih eşleşmedi (değer loglanmaz)" : "Tarih anlaşılamadı", ref: ["EC-63"], seviye: left ? "uyari" : "kritik" });
    return left ? { ok: true, verified: false, attempts_left: left } : { ok: true, verified: false, attempts_left: 0, action: "END_CALL" };
  }

  get_customer_context(callId: string) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    const c = this.repo.customer(s.customerId)!;
    const addr = c.adresler.find((x) => x.id === c.teslimAdresId) ?? c.adresler[0];
    const b = this.activeBooking(c.id);
    const slot = b ? this.repo.slots().find((x) => x.id === b.slotId) : undefined;
    const notes = this.repo.notes().filter((n) => n.customerId === c.id && n.visibility === "asena" && !n.arsivlendi)
      .sort((x, y) => Number(!!y.pinned) - Number(!!x.pinned) || isoToMs(y.createdAt) - isoToMs(x.createdAt)).slice(0, 10).map((n) => n.text);
    const plans = this.repo.schedules().filter((p) => p.customerId === c.id && p.status === "bekliyor" && ["geri_arama", "tekrar_deneme", "bekleme_listesi_arama"].includes(p.type))
      .map((p) => `${p.type} ${p.dueAt.slice(11, 16)}`);
    const f = this.repo.flags(c.id);
    return {
      ok: true as const, hitap: hitapOf(c), ilce: addr.ilce, teslim_adresi_tipi: addr.tip, basarisiz_teslim: "Salı",
      aktif_randevu: b && slot ? { slot_id: slot.id, sozlu: spokenSlot(slot) } : null,
      notlar: notes, acik_planlar: plans, bayraklar: { iletisim_kanali: f.iletisim_kanali, dil: f.dil },
      dogrulanmis_adres_tipleri: this.verifiedAddresses(c).map((x) => x.tip),
    };
  }

  get_available_slots(callId: string, a: { reason?: string } = {}) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    const c = this.repo.customer(s.customerId)!;
    const addrs = this.verifiedAddresses(c);
    const all = this.repo.slots().filter((sl) => addrs.some((ad) => sameDistrict(ad.ilce, sl.ilce)));
    const views: SlotView[] = [];
    let dolu = 0; let kapali = 0;
    for (const sl of all.sort((x, y) => slotStartMs(x) - slotStartMs(y))) {
      if (!this.slotOpen(sl)) { kapali++; continue; }
      const free = this.freeCount(sl, callId);
      if (free <= 0) { dolu++; continue; }
      const ad = addrs.find((x) => sameDistrict(x.ilce, sl.ilce))!;
      views.push({ slot_id: sl.id, gun: spokenSlot(sl).split(" ")[0], tarih: sl.tarih, baslangic: sl.baslangic, bitis: sl.bitis, bos_yer: free, sozlu: spokenSlot(sl), adres_tipi: ad.tip, ilce: sl.ilce });
    }
    this.decide(s, {
      actor: "asena", tip: "slot_sorgu",
      ozet: views.length ? views.map((v) => `${v.slot_id}: ${v.bos_yer} boş`).join(" · ") : "Uygun boş slot yok",
      gerekce: `${a.reason ? a.reason + " · " : ""}Doğrulanmış adres ilçeleri: ${addrs.map((x) => x.ilce).join(", ")}; ${all.length} slot, ${dolu} dolu, ${kapali} kapalı (K-05)`,
      veri: { slots: views.map((v) => v.slot_id) }, ref: ["K-01", "K-03", "K-05"], seviye: "bilgi",
    });
    return { ok: true as const, slots: views, ilce_slot_sayisi: all.length, dolu_sayisi: dolu, kapali_sayisi: kapali };
  }

  async hold_slot(callId: string, a: { slot_id: string; reason?: string }) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    return this.lock("asena-slots", () => {
      const c = this.repo.customer(s.customerId)!;
      const slot = this.repo.slots().find((x) => x.id === a.slot_id); // kilit içinde yeniden okunur
      if (!slot) return err("ERR_SLOT_NOT_FOUND", "Slot yok. get_available_slots ile güncel listeyi al.");
      if (!this.verifiedAddresses(c).some((ad) => sameDistrict(ad.ilce, slot.ilce))) {
        this.decide(s, { actor: "guardrail", tip: "guardrail", ozet: "Başka ilçenin slotu reddedildi", gerekce: "Slot müşterinin doğrulanmış ilçesinde değil", ref: ["RF-09"], seviye: "kritik" });
        return err("ERR_WRONG_DISTRICT", "Bu slot müşterinin ilçesinde değil.");
      }
      if (!this.slotOpen(slot)) return err("ERR_CUTOFF_PASSED", "Bu slotun kesinleşme son anı geçti (K-05).");
      const now = this.wallNow();
      const holds = this.repo.holds().filter((h) => h.expiresAt > now && h.callId !== callId);
      this.repo.saveHolds(holds);
      if (this.freeCount(slot, callId) <= 0) {
        this.decide(s, { actor: "asena", tip: "hold", ozet: `${slot.id} dolu`, gerekce: "Kapasite dolu (atomik kontrol)", ref: ["K-03", "EC-55"], seviye: "uyari" });
        return err("ERR_SLOT_FULL", "SLOT_FULL: Bu slot doldu. get_available_slots ile güncel listeyi al.");
      }
      const h: Hold = { id: uid("H"), slotId: slot.id, customerId: c.id, callId, expiresAt: now + HOLD_TTL_S * 1000 };
      this.repo.saveHolds([...holds, h]);
      this.decide(s, { actor: "asena", tip: "hold", ozet: `${slot.id} ayrıldı (${HOLD_TTL_S} sn)`, gerekce: a.reason ?? "Müşteri slotu kabul etti", ref: ["K-04"], seviye: "bilgi", veri: { slot: slot.id } });
      return { ok: true as const, hold_id: h.id, expires_in_s: HOLD_TTL_S, slot_id: slot.id, sozlu: spokenSlot(slot) };
    });
  }

  async release_slot(callId: string, a: { hold_id: string; reason?: string }) {
    const s = this.s(callId);
    return this.lock("asena-slots", () => {
      const holds = this.repo.holds();
      const h = holds.find((x) => x.id === a.hold_id);
      this.repo.saveHolds(holds.filter((x) => x.id !== a.hold_id));
      if (h) this.decide(s, { actor: "asena", tip: "hold", ozet: `${h.slotId} ayırma bırakıldı`, gerekce: a.reason ?? "Teyit alınamadı", ref: ["K-04"], seviye: "bilgi" });
      return { ok: true as const };
    });
  }

  async confirm_booking(callId: string, a: { hold_id: string; customer_confirmed: boolean; kismi_musaitlik?: { bitis: string }; reason?: string }) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    if (a.customer_confirmed !== true) return err("ERR_NOT_CONFIRMED", "Kapalı teyit sorusuna kesin evet alınmadı (RF-24).");
    return this.lock("asena-slots", () => {
      const holds = this.repo.holds();
      const h = holds.find((x) => x.id === a.hold_id && x.callId === callId);
      if (!h || h.expiresAt <= this.wallNow()) return err("ERR_HOLD_EXPIRED", "Ayırma süresi doldu; tekrar hold_slot gerekli.");
      const slot = this.repo.slots().find((x) => x.id === h.slotId);
      if (!slot || !this.slotOpen(slot)) return err("ERR_CUTOFF_PASSED", "Slot kapandı veya silindi.");
      if (a.kismi_musaitlik) {
        const start = localToMs(slot.tarih, slot.baslangic), end = localToMs(slot.tarih, slot.bitis);
        const until = Math.min(end, localToMs(slot.tarih, a.kismi_musaitlik.bitis));
        if ((until - start) / (end - start) < 0.5) return err("ERR_PARTIAL_TOO_SHORT", "Müşteri aralığın yarısından azında adreste (K-22).");
      }
      const c = this.repo.customer(s.customerId)!;
      const addr = this.verifiedAddresses(c).find((ad) => sameDistrict(ad.ilce, slot.ilce))!;
      // K-02: eski aktif randevu iptal
      const bookings = this.repo.bookings();
      for (const b of bookings) if (b.customerId === c.id && b.status === "aktif") { b.status = "iptal"; b.iptalNedeni = "yeni randevu (K-02)"; }
      const code = String(1000 + Math.floor(Math.random() * 9000));
      const booking: Booking = {
        id: uid("B"), slotId: slot.id, customerId: c.id, createdAt: this.now(), status: "aktif", adresTipi: addr.tip,
        kismiMusaitlik: a.kismi_musaitlik, kuryeKoduHash: hash(code), callId,
      };
      this.repo.saveBookings([...bookings, booking]);
      this.repo.saveHolds(holds.filter((x) => x.id !== h.id));
      this.repo.updateCustomer(c.id, (x) => { x.durum = "randevu_verildi"; });
      this.repo.saveWaitlist(this.repo.waitlist().map((w) => (w.customerId === c.id ? { ...w, status: "kapandi" } : w)));
      const dec = this.decide(s, { actor: "asena", tip: "randevu", ozet: `Randevu kesinleşti: ${slot.id}${a.kismi_musaitlik ? ` (kısmi, ${a.kismi_musaitlik.bitis}'e kadar)` : ""}`, gerekce: a.reason ?? "Kapalı teyit sorusuna kesin evet", ref: ["K-21", "RF-24", ...(a.kismi_musaitlik ? ["K-22"] : [])], seviye: "bilgi", veri: { slot: slot.id, booking: booking.id } });
      // EC-81 / K-19 / K-28: servis sorumluluğu — teyit SMS'i (kurye kodu yalnız burada) + hatırlatma planı
      const kb = this.kb();
      if (kb.flags.randevu_teyit_sms) {
        this.sendSms(s, c.id, "randevu_teyit", { gun: spokenSlot(slot).split(" ")[0], aralik: `${slot.baslangic}–${slot.bitis}`, adres_tipi: addr.tip === "Ev" ? "ev" : "iş yeri", kurye_kodu: code }, dec.id);
      }
      if (kb.flags.hatirlatma_sms) {
        this.plan(s, { customerId: c.id, type: "hatirlatma_sms", dueAt: msToIso(localToMs(addDays(slot.tarih, -1), "18:00")), channel: "sms", source: "system", reason: "Teslimden önceki gün 18:00 hatırlatma", linkedEc: "EC-81" });
      }
      return { ok: true as const, booking_id: booking.id, slot_id: slot.id, sozlu_ozet: `${spokenSlot(slot)}, kayıtlı ${addr.tip === "Ev" ? "ev" : "iş yeri"} adresinize`, adres_tipi: addr.tip };
    });
  }

  async cancel_booking(callId: string, a: { booking_id: string; reason: string }) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    return this.lock("asena-slots", () => this.cancelBookingInternal(s, a.booking_id, a.reason));
  }

  private cancelBookingInternal(s: Session | null, bookingId: string, reason: string) {
    const bookings = this.repo.bookings();
    const b = bookings.find((x) => x.id === bookingId && x.status === "aktif");
    if (!b) return err("ERR_NO_BOOKING", "Aktif randevu yok.");
    b.status = "iptal"; b.iptalNedeni = reason;
    this.repo.saveBookings(bookings);
    const slot = this.repo.slots().find((x) => x.id === b.slotId);
    this.decide(s ?? { customerId: b.customerId }, { actor: "asena", tip: "randevu_iptal", customerId: b.customerId, ozet: `Randevu iptal: ${b.slotId}`, gerekce: reason, ref: ["K-24", "EC-54"], seviye: "uyari" });
    if (slot && this.slotOpen(slot)) this.offerFreedSlot(s, slot);
    return { ok: true as const };
  }

  /** K-24: yer boşalınca aynı ilçenin bekleme listesindeki ilk müşteri için arama planı. */
  offerFreedSlot(s: Session | null, slot: CourierSlot) {
    const next = this.repo.waitlist().filter((w) => w.status === "aktif" && sameDistrict(w.ilce, slot.ilce)).sort((x, y) => isoToMs(x.createdAt) - isoToMs(y.createdAt))[0];
    if (!next) return null;
    return this.plan(s, { customerId: next.customerId, type: "bekleme_listesi_arama", dueAt: this.now(), channel: "ses", source: "system", reason: `${slot.id} boşaldı`, linkedEc: "EC-54" });
  }

  add_to_waitlist(callId: string, a: { reason: "kapasite_dolu" | "musteri_uygun_degil"; tercih_notu?: string; why?: string }) {
    const s = this.s(callId); const g = this.gate(s); if (g) return g;
    const c = this.repo.customer(s.customerId)!;
    const addr = c.adresler.find((x) => x.id === c.teslimAdresId) ?? c.adresler[0];
    let note = a.tercih_notu;
    if (note && checkNote(note).length) note = undefined;
    const list = this.repo.waitlist().filter((w) => !(w.customerId === c.id && w.status === "aktif"));
    list.push({ id: uid("W"), customerId: c.id, ilce: addr.ilce, reason: a.reason, tercihNotu: note, createdAt: this.now(), status: "aktif" });
    this.repo.saveWaitlist(list);
    this.repo.updateCustomer(c.id, (x) => { x.durum = "bekleme_listesi"; });
    this.decide(s, { actor: "asena", tip: "bekleme_listesi", ozet: `${c.adSoyad} bekleme listesine alındı (${a.reason})`, gerekce: a.why ?? (a.reason === "kapasite_dolu" ? "İlçedeki yerler doldu" : "Müşteri sunulan zamanlarda uygun değil"), ref: ["K-07", "K-08", "EC-51"], seviye: "uyari" });
    if (note) this.add_note(callId, { category: "musaitlik", visibility: "asena", text: note, linked_ec: "EC-51" });
    return { ok: true as const };
  }

  schedule_callback(callId: string, a: { when: string; source: "musteri" | "ucuncu_kisi" | "baglanti_koptu"; reason?: string }) {
    const s = this.s(callId);
    return this.scheduleVoice(s, s.customerId, "geri_arama", a.when, a.source, a.reason ?? "Geri arama talebi", a.source === "ucuncu_kisi" ? "EC-10" : a.source === "baglanti_koptu" ? "EC-90" : "K-12");
  }

  /** Sesli plan kuralları (musteri-notlari §3.2): K-11, günde 3 / 2 saat, bayraklar, BU_HAFTA_RISKLI. */
  scheduleVoice(s: Session | null, customerId: string, type: ScheduleType, whenIso: string, source: Schedule["source"], reason: string, ec?: string) {
    const f = this.repo.flags(customerId);
    if (f.aranmasin) return err("ERR_DO_NOT_CALL", "Aranmasın bayrağı var; sesli plan oluşturulamaz (RF-30).");
    if (f.teslimat_donduruldu) return err("ERR_FROZEN", "Teslimat donduruldu; arama planı oluşturulamaz (K-25).");
    let when = isoToMs(whenIso);
    const wanted = when;
    if (!inCallHours(when)) {
      const sug = nextCallableMs(when);
      if (source === "musteri") return err("ERR_OUTSIDE_CALL_HOURS", "Arama saatleri dışında (K-11).", { suggestion: msToIso(sug) });
      when = sug;
    }
    const day = parts(when).date;
    const sameDay = this.repo.attempts().filter((x) => x.customerId === customerId && x.yon === "giden" && parts(isoToMs(x.at)).date === day);
    const lastAt = Math.max(0, ...sameDay.map((x) => isoToMs(x.at)));
    if (lastAt && when - lastAt < 2 * 3600_000) when = nextCallableMs(lastAt + 2 * 3600_000);
    if (sameDay.length >= 3) when = nextCallableMs(localToMs(addDays(day, 1), "09:00"));
    const c = this.repo.customer(customerId);
    const ilce = c?.adresler.find((x) => x.id === c.teslimAdresId)?.ilce;
    const cutoffs = this.repo.slots().filter((sl) => ilce && sameDistrict(sl.ilce, ilce) && sl.aktif).map(slotCutoffMs);
    const risky = cutoffs.length > 0 && cutoffs.every((co) => when > co - 2 * 3600_000);
    const p = this.plan(s, { customerId, type, dueAt: msToIso(when), channel: "ses", source, reason, linkedEc: ec, uyari: risky ? "BU_HAFTA_RISKLI" : undefined });
    return { ok: true as const, schedule_id: p.id, when: p.dueAt, shifted: when !== wanted, warning: risky ? "BU_HAFTA_RISKLI" : undefined };
  }

  plan(s: Partial<Session> | null, p: Omit<Schedule, "id" | "createdAt" | "status"> & { status?: Schedule["status"] }): Schedule {
    const all = this.repo.schedules();
    const f = this.repo.flags(p.customerId);
    // Bir müşteri için aynı tipte tek "bekliyor" plan: yenisi eskisini günceller
    const existing = all.find((x) => x.customerId === p.customerId && x.type === p.type && x.status === "bekliyor");
    const sched: Schedule = { ...p, id: existing?.id ?? uid("P"), createdAt: this.now(), status: p.status ?? "bekliyor", createdByCallId: s?.callId };
    if (p.type === "insan_geri_arama" && !sched.slaDeadline) sched.slaDeadline = this.addBusinessHours(this.nowMs(), this.kb().slaSaat);
    if (f.teslimat_donduruldu && !p.type.startsWith("insan_") && !p.type.startsWith("guvenlik_") && p.channel !== "sms") sched.status = "iptal";
    this.repo.saveSchedules(existing ? all.map((x) => (x.id === existing.id ? sched : x)) : [...all, sched]);
    this.decide(s, { actor: s?.callId ? "asena" : "sistem", tip: "plan", customerId: p.customerId, ozet: `Plan: ${p.type} · ${p.dueAt.slice(0, 16).replace("T", " ")}${sched.uyari ? " ⚠ BU_HAFTA_RISKLI" : ""}`, gerekce: p.reason, ref: p.linkedEc ? [p.linkedEc] : undefined, seviye: sched.uyari ? "uyari" : "bilgi" });
    return sched;
  }

  addBusinessHours(ms: number, h: number) {
    let t = nextCallableMs(ms); let left = h * 60;
    while (left > 0) { t += 60_000 * 15; left -= 15; if (!inCallHours(t)) t = nextCallableMs(t); }
    return msToIso(t);
  }

  log_complaint(callId: string, a: { kategori: "teslim_edilemedi_itirazi" | "kurye_davranisi" | "diger"; ozet: string }) {
    const s = this.s(callId);
    const ozet = maskInput(a.ozet).text.slice(0, 200);
    this.decide(s, { actor: "asena", tip: "sikayet", ozet: `Şikayet: ${a.kategori}`, gerekce: ozet, ref: ["EC-32", "EC-73"], seviye: "uyari" });
    if (s.verified) this.add_note(callId, { category: "itiraz", visibility: "internal", text: ozet, linked_ec: "EC-32" });
    if (a.kategori === "teslim_edilemedi_itirazi") {
      this.plan(s, { customerId: s.customerId, type: "kurye_firmasi_inceleme", dueAt: this.addBusinessHours(this.nowMs(), 8), channel: "ic_islem", source: "asena", reason: "Teslim edilemedi itirazı incelenecek", linkedEc: "EC-32" });
    }
    return { ok: true as const };
  }

  log_event(callId: string, a: { type: string; detail: string }) {
    const s = this.s(callId);
    this.decide(s, { actor: "guardrail", tip: "guvenlik", ozet: `Olay: ${a.type}`, gerekce: maskInput(a.detail).text.slice(0, 200), ref: [eventRef(a.type)], seviye: a.type === "prompt_injection" || a.type === "hassas_veri_okuma_girisimi" ? "kritik" : "uyari" });
    return { ok: true as const };
  }

  request_human_handoff(callId: string, a: { reason: "musteri_talebi" | "kart_talep_itirazi" | "risk_sinyali" | "zorlanan_musteri" | "hassas_durum" | "acil"; preferredIso?: string }) {
    const s = this.s(callId);
    const sla = this.addBusinessHours(this.nowMs(), this.kb().slaSaat);
    const due = a.preferredIso && isoToMs(a.preferredIso) < isoToMs(sla) ? a.preferredIso : sla;
    const p = this.plan(s, { customerId: s.customerId, type: "insan_geri_arama", dueAt: due, slaDeadline: sla, channel: "insan", source: "asena", reason: `İnsana aktarım: ${a.reason}`, linkedEc: "EC-71" });
    this.decide(s, { actor: "asena", tip: "insana_aktarim", ozet: `İnsana aktarım (${a.reason})`, gerekce: `SLA ${sla.slice(11, 16)}`, ref: ["EC-71", "K-27"], seviye: a.reason === "musteri_talebi" ? "bilgi" : "kritik" });
    return { ok: true as const, sla_until: sla, schedule_id: p.id };
  }

  answer_from_kb(_callId: string, a: { question: string }) {
    const kb = this.kb();
    const q = a.question.toLocaleLowerCase("tr");
    const keys: [RegExp, RegExp][] = [
      [/aktif|aktive|aktifleş/, /aktif/i], [/şifre|pin/, /şifre/i], [/yıllık|aidat/, /yıllık ücret/i], [/limit/, /limit/i],
      [/ücret|para|bedel/, /ücret/i], [/kimlik|belge/, /kimlik|belge/i],
    ];
    for (const [qr, fr] of keys) {
      if (!qr.test(q)) continue;
      const hit = kb.faq.find((f) => fr.test(f.q));
      if (hit) return { ok: true as const, found: true, answer: hit.a };
      if (fr.source.includes("ücret") && !/yıllık|aidat/.test(q)) return { ok: true as const, found: true, answer: "Yeniden teslim için herhangi bir ücret yok." };
    }
    return { ok: true as const, found: false };
  }

  add_note(callId: string, a: { category: NoteCategory; visibility: NoteVisibility; text: string; linked_ec?: string }) {
    const s = this.s(callId);
    if (!s.verified && !(a.category === "iletisim" && a.visibility === "internal")) {
      return err("ERR_NOTE_REJECTED", "Doğrulama öncesinde yalnız iletisim/internal not yazılabilir.");
    }
    const masked = maskInput(a.text).text.slice(0, 280);
    const v = checkNote(masked);
    if (v.length) {
      this.decide(s, { actor: "guardrail", tip: "guardrail", ozet: "Not reddedildi", gerekce: v.map((x) => x.reason).join(", "), ref: ["RF-31"], seviye: "uyari" });
      return err("ERR_NOTE_REJECTED", "Not yasaklı içerik içeriyor (RF-31).");
    }
    const n = { id: uid("N"), customerId: s.customerId, createdAt: this.now(), updatedAt: this.now(), author: "asena" as const, callId, category: a.category, visibility: a.visibility, text: masked, linkedEc: a.linked_ec };
    this.repo.saveNotes([...this.repo.notes(), n]);
    this.decide(s, { actor: "asena", tip: "not", ozet: `Not (${a.category}/${a.visibility}): ${masked}`, gerekce: a.linked_ec ?? "", ref: a.linked_ec ? [a.linked_ec] : undefined, seviye: "bilgi" });
    return { ok: true as const, note_id: n.id };
  }

  /** Sert durdurma (K-25). Doğrulama gerektirmez; güvenli yöndedir. */
  async freeze_delivery(callId: string, a: { reason: FreezeReason }) {
    const s = this.s(callId);
    return this.lock("asena-slots", () => {
      const holds = this.repo.holds();
      this.repo.saveHolds(holds.filter((h) => h.customerId !== s.customerId));
      for (const b of this.repo.bookings().filter((x) => x.customerId === s.customerId && x.status === "aktif")) this.cancelBookingInternal(s, b.id, `Sert durdurma: ${a.reason}`);
      this.repo.setFlags(s.customerId, (f) => {
        f.teslimat_donduruldu = { since: this.now(), reason: a.reason };
        if (a.reason === "vefat_bildirimi" || a.reason === "ulasilamaz_durum") f.aranmasin = { since: this.now(), reason: a.reason };
      });
      this.repo.saveSchedules(this.repo.schedules().map((p) => (p.customerId === s.customerId && p.status === "bekliyor" && p.channel === "ses" ? { ...p, status: "iptal" } : p)));
      this.repo.saveWaitlist(this.repo.waitlist().map((w) => (w.customerId === s.customerId ? { ...w, status: "kapandi" } : w)));
      this.repo.updateCustomer(s.customerId, (c) => { c.durum = "teslimat_donduruldu"; });
      this.decide(s, { actor: "asena", tip: "sert_durdurma", ozet: `Teslimat donduruldu (${a.reason})`, gerekce: "Sert durdurma: randevu yok, varsa iptal, insana geçiş", ref: ["K-25", freezeRef(a.reason)], seviye: "kritik" });
      return { ok: true as const };
    });
  }

  report_security(callId: string, a: { type: "basvuru_itirazi" | "teslim_kaydi_uyusmazligi" | "zorlama_suphesi" | "tekrarlayan_dogrulama_hatasi"; summary: string }) {
    const s = this.s(callId);
    const ec = { basvuru_itirazi: "EC-30", teslim_kaydi_uyusmazligi: "EC-31", zorlama_suphesi: "EC-35", tekrarlayan_dogrulama_hatasi: "EC-63" }[a.type];
    this.repo.setFlags(s.customerId, (f) => { f.guvenlik_incelemesi = { since: this.now(), ec }; });
    this.plan(s, { customerId: s.customerId, type: "guvenlik_geri_arama", dueAt: this.addBusinessHours(this.nowMs(), 2), channel: "insan", source: "asena", reason: `Güvenlik vakası: ${a.type}`, linkedEc: ec });
    this.decide(s, { actor: "asena", tip: "guvenlik", ozet: `Güvenlik vakası açıldı: ${a.type}${a.type !== "tekrarlayan_dogrulama_hatasi" ? " · kart bloke talebi (prototipte vaka, AK-08)" : ""}`, gerekce: maskInput(a.summary).text.slice(0, 160), ref: [ec, "AK-08"], seviye: "kritik" });
    return { ok: true as const };
  }

  set_contact_preference(callId: string, a: { aranmasin?: boolean; iletisim_kanali?: "ses" | "yazili"; dil?: "tr" | "en" }) {
    const s = this.s(callId);
    this.repo.setFlags(s.customerId, (f) => {
      if (a.aranmasin) f.aranmasin = { since: this.now(), reason: s.verified ? "Müşteri talebi" : "Bu numara için talep (doğrulama öncesi)" };
      if (a.iletisim_kanali) f.iletisim_kanali = a.iletisim_kanali;
      if (a.dil) f.dil = a.dil;
    });
    if (a.aranmasin || a.iletisim_kanali === "yazili") {
      this.repo.saveSchedules(this.repo.schedules().map((p) => (p.customerId === s.customerId && p.status === "bekliyor" && p.channel === "ses" ? { ...p, status: "iptal" } : p)));
      this.sendSms(s, s.customerId, "self_servis_link", {});
    }
    if (a.iletisim_kanali === "yazili") this.plan(s, { customerId: s.customerId, type: "link_kontrol", dueAt: msToIso(this.nowMs() + 24 * 3600_000), channel: "ic_islem", source: "asena", reason: "Yazılı kanal: self-servis bağlantısı kontrolü", linkedEc: "EC-15" });
    this.decide(s, { actor: "asena", tip: "bayrak", ozet: `İletişim tercihi: ${JSON.stringify(a)}`, gerekce: a.aranmasin ? "Müşteri sesli arama istemiyor" : "Kanal/dil tercihi", ref: a.aranmasin ? ["EC-72", "K-26", "RF-30"] : ["EC-15"], seviye: "uyari" });
    if (a.aranmasin) this.repo.updateCustomer(s.customerId, (c) => { c.durum = "aranmasin"; });
    return { ok: true as const };
  }

  log_attempt(customerId: string, a: { sonuc: "cevaplandi" | "cevapsiz" | "sesli_mesaj" | "mesgul" | "yanlis_numara"; yon?: "giden" | "gelen"; callId?: string; outcome?: string; runId?: string }) {
    this.repo.saveAttempts([...this.repo.attempts(), { id: uid("T"), customerId, at: this.now(), yon: a.yon ?? "giden", sonuc: a.sonuc, callId: a.callId, outcome: a.outcome }]);
    if (a.sonuc === "cevapsiz" || a.sonuc === "sesli_mesaj" || a.sonuc === "mesgul") {
      const today = parts(this.nowMs()).date;
      const n = this.repo.attempts().filter((x) => x.customerId === customerId && x.yon === "giden" && parts(isoToMs(x.at)).date === today && x.sonuc !== "cevaplandi").length;
      const total = this.repo.attempts().filter((x) => x.customerId === customerId && x.sonuc !== "cevaplandi").length;
      if (total >= 3) {
        this.repo.updateCustomer(customerId, (c) => { c.durum = "ulasilamadi"; });
        this.sendSms({ customerId, runId: a.runId }, customerId, "ulasilamadi", {});
      } else {
        this.scheduleVoice({ customerId, runId: a.runId } as Session, customerId, "tekrar_deneme", msToIso(this.nowMs() + 2 * 3600_000 + (n > 1 ? 3 * 3600_000 : 0)), "system", "Cevapsız arama, sonraki pencere", "EC-14");
      }
    }
    return { ok: true as const };
  }

  sendSms(s: Partial<Session> | null, customerId: string, t: SmsTemplate, vars: SmsVars, decisionId?: string, operatorBody?: string) {
    const body = renderSms(t, this.kb(), vars, operatorBody);
    const sms = { id: uid("S"), customerId, at: this.now(), template: t, body, status: "gonderildi" as const, decisionId, callId: s?.callId };
    this.repo.saveOutbox([...this.repo.outbox(), sms]);
    const shown = t === "randevu_teyit" ? body.replace(/\b\d{4}\b/, "••••") : body;
    this.decide(s, { actor: t === "operator" ? "operator" : "sistem", tip: "sms", customerId, ozet: `SMS (${t}) → ${this.repo.customer(customerId)?.adSoyad ?? customerId}`, gerekce: shown.slice(0, 160), ref: t === "randevu_teyit" ? ["K-19", "K-28", "RF-33"] : ["K-19"], seviye: "bilgi" });
    return sms;
  }

  end_call(callId: string, a: { outcome: Outcome; summary: string; slotId?: string }) {
    const s = this.s(callId);
    const now = this.wallNow();
    this.repo.saveHolds(this.repo.holds().filter((h) => h.callId !== callId && h.expiresAt > now));
    const statusMap: Partial<Record<Outcome, Customer["durum"]>> = {
      randevu_verildi: "randevu_verildi", bekleme_listesi: "bekleme_listesi", geri_arama: "geri_arama", ucuncu_kisi: "ucuncu_kisi",
      dogrulama_basarisiz: "dogrulama_basarisiz", kart_talep_itirazi: "kart_talep_itirazi", insana_aktarildi: "insana_aktarildi",
      musteri_kayit_istemedi: "musteri_kayit_istemedi", yanlis_numara: "yanlis_numara", baglanti_koptu: "geri_arama",
      teslimat_donduruldu: "teslimat_donduruldu", aranmasin: "aranmasin", teslim_engeli: "teslim_engeli",
    };
    const f = this.repo.flags(s.customerId);
    this.repo.updateCustomer(s.customerId, (c) => {
      if (f.teslimat_donduruldu) c.durum = "teslimat_donduruldu";
      else if (f.aranmasin) c.durum = "aranmasin";
      else if (!(c.durum === "randevu_verildi" && a.outcome !== "randevu_verildi" && this.activeBooking(c.id))) c.durum = statusMap[a.outcome] ?? c.durum;
    });
    this.log_attempt(s.customerId, { sonuc: a.outcome === "yanlis_numara" ? "yanlis_numara" : "cevaplandi", yon: s.yon, callId, outcome: a.outcome });
    const call = this.repo.calls().find((x) => x.id === callId);
    if (call) this.repo.upsertCall({ ...call, endedAt: this.now(), outcome: a.outcome, summary: a.summary, slotId: a.slotId });
    this.decide(s, { actor: "asena", tip: "durum_gecisi", ozet: `Görüşme bitti: ${a.outcome}`, gerekce: a.summary, seviye: "bilgi" });
    this.sessions.delete(callId);
    return { ok: true as const };
  }

  /** Görüşme sonrası otomatik eylemler (toplu-demo §3 tablo). Asena'nın konuşmasından bağımsızdır. */
  postCallActions(callId: string, customerId: string, outcome: Outcome, ctx: { waitlistReason?: "kapasite_dolu" | "musteri_uygun_degil"; runId?: string }) {
    const s = { callId, customerId, runId: ctx.runId };
    const c = this.repo.customer(customerId);
    if (!c) return;
    if (outcome === "bekleme_listesi") {
      this.sendSms(s, customerId, ctx.waitlistReason === "kapasite_dolu" ? "bolge_dolu" : "bekleme_listesi", {});
      if (ctx.waitlistReason === "kapasite_dolu") this.plan(s, { customerId, type: "bekleme_listesi_kontrol", dueAt: this.now(), channel: "ic_islem", source: "system", reason: "Her iptalde tetiklenir", linkedEc: "EC-00a" });
      const nextMon = addDays(this.repo.settings().simulation.weekMonday, 7);
      this.plan(s, { customerId, type: "gelecek_hafta_arama", dueAt: msToIso(localToMs(addDays(nextMon, 1), "10:00")), channel: "ses", source: "system", reason: "Gelecek hafta öncelikli arama (K-08)", linkedEc: "EC-51" });
    }
    if (outcome === "musteri_kayit_istemedi") this.sendSms(s, customerId, "self_servis_link", {});
  }
}

function eventRef(t: string) {
  return ({ adres_degisikligi_talebi: "RF-08", ucuncu_kisiye_teslim_talebi: "RF-07", hassas_veri_okuma_girisimi: "RF-01", prompt_injection: "EC-94", dolandiricilik_suphesi: "RF-18", kayit_reddi: "RF-11", vekalet_talebi: "RF-28", kb_celiski: "EC-99" } as Record<string, string>)[t] ?? t;
}
function freezeRef(r: FreezeReason) {
  return { basvuru_itirazi: "EC-30", teslim_kaydi_uyusmazligi: "EC-31", vefat_bildirimi: "EC-13", ulasilamaz_durum: "EC-13", musteri_iptal_talebi: "EC-33", zorlama_suphesi: "EC-35" }[r];
}
