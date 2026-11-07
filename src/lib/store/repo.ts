// Repository: tek otorite localStorage (musteri-notlari-ve-planlama.md §2). Her okuma o anki veriyi döndürür.
import type {
  Attempt, Booking, CallRecord, CharacterLibrary, CourierSlot, Customer, CustomerFlags, Decision, Hold, KbDoc, Note, Run,
  Schedule, Settings, Sms, WaitlistEntry,
} from "../domain/types";
import { CustomerSchema, SlotSchema } from "../domain/schemas";
import { characterLibrarySeed, defaultKb, defaultSettings, caseCustomers, caseSlots } from "../seed";
import { PREFIX, type KV } from "./kv";

type List<T> = { schemaVersion: 1; items: T[] };

export const KEYS = [
  "customers", "courierSlots", "bookings", "holds", "waitlist", "notes", "schedules", "flags", "attempts", "outbox",
  "decisions", "calls", "runs", "settings", "kb", "characterLibrary", "meta",
] as const;
export type Key = (typeof KEYS)[number];

let idCounter = 0;
export function uid(prefix: string) {
  idCounter = (idCounter + 1) % 1_000_000;
  const rnd = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

export class Repo {
  constructor(public kv: KV, public notify: (keys: Key[]) => void = () => {}) {}

  private raw<T>(key: Key, fallback: T): T {
    const s = this.kv.get(PREFIX + key);
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  }
  private put(key: Key, value: unknown) {
    this.kv.set(PREFIX + key, JSON.stringify(value));
    this.notify([key]);
  }
  private list<T>(key: Key): T[] {
    const v = this.raw<List<T> | T[] | null>(key, null);
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return Array.isArray(v.items) ? v.items : [];
  }
  private setList<T>(key: Key, items: T[]) { this.put(key, { schemaVersion: 1, items }); }

  // ------------------------------------------------------------- ayarlar
  settings(): Settings {
    const d = defaultSettings();
    const s = this.raw<Partial<Settings>>("settings", {});
    return {
      ...d, ...s,
      engine: { ...d.engine, ...s.engine }, llm: { ...d.llm, ...s.llm }, tts: { ...d.tts, ...s.tts },
      behavior: { ...d.behavior, ...s.behavior }, simulation: { ...d.simulation, ...s.simulation }, demo: { ...d.demo, ...s.demo },
    };
  }
  saveSettings(s: Settings) { this.put("settings", s); }
  patchSettings(fn: (s: Settings) => void) { const s = this.settings(); fn(s); this.saveSettings(s); return s; }
  now(): string { return this.settings().simulation.now; }

  kb(): KbDoc[] { const v = this.raw<{ docs: KbDoc[] } | null>("kb", null); return v?.docs ?? defaultKb(this.now()); }
  saveKb(docs: KbDoc[]) { this.put("kb", { docs }); }

  characterLibrary(): CharacterLibrary { return this.raw<CharacterLibrary | null>("characterLibrary", null) ?? characterLibrarySeed(); }
  saveCharacterLibrary(lib: CharacterLibrary) { this.put("characterLibrary", lib); }

  // ------------------------------------------------------------- müşteriler / slotlar
  customersAll(): { valid: Customer[]; invalid: { raw: unknown; error: string }[] } {
    const valid: Customer[] = []; const invalid: { raw: unknown; error: string }[] = [];
    for (const c of this.list<unknown>("customers")) {
      const r = CustomerSchema.safeParse(c);
      if (r.success) valid.push(r.data as Customer); else invalid.push({ raw: c, error: r.error.issues.map((i) => i.message).join("; ") });
    }
    return { valid, invalid };
  }
  customers(): Customer[] { return this.customersAll().valid; }
  customer(id: string) { return this.customers().find((c) => c.id === id); }
  saveCustomers(cs: Customer[]) { this.setList("customers", cs); }
  upsertCustomer(c: Customer) {
    const all = this.list<Customer>("customers");
    const i = all.findIndex((x) => x.id === c.id);
    c.updatedAt = this.now();
    if (i >= 0) all[i] = c; else all.push(c);
    this.setList("customers", all);
  }
  updateCustomer(id: string, fn: (c: Customer) => void) {
    const all = this.list<Customer>("customers");
    const c = all.find((x) => x.id === id);
    if (!c) return;
    fn(c); c.updatedAt = this.now();
    this.setList("customers", all);
  }
  deleteCustomer(id: string) { this.setList("customers", this.list<Customer>("customers").filter((c) => c.id !== id)); }

  slotsAll(): { valid: CourierSlot[]; invalid: { raw: unknown; error: string }[] } {
    const valid: CourierSlot[] = []; const invalid: { raw: unknown; error: string }[] = [];
    for (const s of this.list<unknown>("courierSlots")) {
      const r = SlotSchema.safeParse(s);
      if (r.success) valid.push(r.data as CourierSlot); else invalid.push({ raw: s, error: r.error.issues.map((i) => i.message).join("; ") });
    }
    return { valid, invalid };
  }
  slots(): CourierSlot[] { return this.slotsAll().valid; }
  saveSlots(s: CourierSlot[]) { this.setList("courierSlots", s); }

  // ------------------------------------------------------------- operasyon
  bookings(): Booking[] { return this.list("bookings"); }
  saveBookings(b: Booking[]) { this.setList("bookings", b); }
  holds(): Hold[] { return this.list("holds"); }
  saveHolds(h: Hold[]) { this.setList("holds", h); }
  waitlist(): WaitlistEntry[] { return this.list("waitlist"); }
  saveWaitlist(w: WaitlistEntry[]) { this.setList("waitlist", w); }
  notes(): Note[] { return this.list("notes"); }
  saveNotes(n: Note[]) { this.setList("notes", n); }
  schedules(): Schedule[] { return this.list("schedules"); }
  saveSchedules(s: Schedule[]) { this.setList("schedules", s); }
  attempts(): Attempt[] { return this.list("attempts"); }
  saveAttempts(a: Attempt[]) { this.setList("attempts", a); }
  outbox(): Sms[] { return this.list("outbox"); }
  saveOutbox(o: Sms[]) { this.setList("outbox", o); }
  calls(): CallRecord[] { return this.list("calls"); }
  saveCalls(c: CallRecord[]) { this.setList("calls", c); }
  upsertCall(c: CallRecord) { const all = this.calls(); const i = all.findIndex((x) => x.id === c.id); if (i >= 0) all[i] = c; else all.push(c); this.saveCalls(all); }
  runs(): Run[] { return this.list("runs"); }
  upsertRun(r: Run) { const all = this.runs(); const i = all.findIndex((x) => x.id === r.id); if (i >= 0) all[i] = r; else all.push(r); this.setList("runs", all); }

  flagsAll(): Record<string, CustomerFlags> { return this.raw<{ byCustomer: Record<string, CustomerFlags> }>("flags", { byCustomer: {} }).byCustomer ?? {}; }
  flags(id: string): CustomerFlags { return this.flagsAll()[id] ?? {}; }
  setFlags(id: string, fn: (f: CustomerFlags) => void) {
    const all = this.flagsAll(); const f = all[id] ?? {}; fn(f); all[id] = f;
    this.put("flags", { schemaVersion: 1, byCustomer: all });
  }

  /** Karar günlüğü = audit log: yalnız ekleme (RF-23). Güncelleme/silme API'si bilerek yoktur. */
  decisions(): Decision[] { return this.list("decisions"); }
  appendDecision(d: Omit<Decision, "id" | "seq" | "at"> & { at?: string }): Decision {
    const all = this.list<Decision>("decisions");
    const dec: Decision = { ...d, id: uid("D"), seq: (all[all.length - 1]?.seq ?? 0) + 1, at: d.at ?? this.now() };
    all.push(dec);
    this.setList("decisions", all.length > 4000 ? all : all);
    return dec;
  }

  // ------------------------------------------------------------- seed / sıfırlama
  meta(): { seeded?: boolean } { return this.raw("meta", {}); }
  ensureSeeded() {
    if (this.meta().seeded) return false;
    const s = defaultSettings();
    if (!this.kv.get(PREFIX + "settings")) this.saveSettings(s);
    if (!this.kv.get(PREFIX + "characterLibrary")) this.saveCharacterLibrary(characterLibrarySeed());
    if (!this.kv.get(PREFIX + "kb")) this.saveKb(defaultKb(s.simulation.now));
    if (!this.kv.get(PREFIX + "customers")) this.saveCustomers(caseCustomers(s.simulation.now));
    if (!this.kv.get(PREFIX + "courierSlots")) this.saveSlots(caseSlots(s.simulation.weekMonday));
    this.put("meta", { seeded: true });
    return true;
  }

  /** Simülasyonu sıfırla: operasyon verisi temizlenir; karar günlüğü (audit) korunur (RF-23). */
  resetOperations() {
    for (const k of ["bookings", "holds", "waitlist", "notes", "schedules", "flags", "attempts", "outbox", "calls", "runs"] as Key[]) this.kv.remove(PREFIX + k);
    const all = this.list<Customer>("customers");
    for (const c of all) { c.durum = "aranacak"; c.kart = { ...c.kart, konum: "depoda" }; }
    this.setList("customers", all);
    this.notify([...KEYS]);
  }

  exportAll(): Record<string, unknown> {
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), version: 1 };
    for (const k of KEYS) { const v = this.kv.get(PREFIX + k); if (v) out[k] = JSON.parse(v); }
    return out;
  }
  importAll(data: Record<string, unknown>) {
    for (const k of KEYS) if (k in data) this.kv.set(PREFIX + k, JSON.stringify(data[k]));
    this.notify([...KEYS]);
  }
}
