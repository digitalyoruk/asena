// Simülasyon saati ve Europe/Istanbul (+03:00, yaz saati yok) yardımcıları.
// K-05 (12 saat son an), K-11 (Pzt–Cmt 09–20), EC-53.

export const TZ_OFFSET_MIN = 180;
export const GUNLER = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"] as const;
export const GUN_KISA = ["paz", "pzt", "sal", "car", "per", "cum", "cmt"] as const;
export const GUN_ADI_TR: Record<string, string> = {
  pazar: "pazar", pazartesi: "pazartesi", sali: "salı", carsamba: "çarşamba", persembe: "perşembe", cuma: "cuma", cumartesi: "cumartesi",
};
export const AYLAR = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-12" + "09:00" → epoch ms (İstanbul saati). */
export function localToMs(date: string, hm = "00:00"): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - TZ_OFFSET_MIN * 60_000;
}

export function msToIso(ms: number): string {
  const t = new Date(ms + TZ_OFFSET_MIN * 60_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+03:00`;
}

export function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

export function parts(ms: number) {
  const t = new Date(ms + TZ_OFFSET_MIN * 60_000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), dow: t.getUTCDay(), day: t.getUTCDate(), month: t.getUTCMonth(),
  };
}

export function dayKey(date: string): (typeof GUNLER)[number] {
  return GUNLER[new Date(localToMs(date, "12:00")).getUTCDay()];
}
export function dayShort(date: string): (typeof GUN_KISA)[number] {
  return GUN_KISA[new Date(localToMs(date, "12:00")).getUTCDay()];
}

export function addDays(date: string, n: number): string {
  return parts(localToMs(date, "12:00") + n * 86_400_000).date;
}

/** Haftanın günü adından (persembe) tarih: weekMonday'e göre. */
export function dateForDay(weekMonday: string, gun: string): string {
  const idx: Record<string, number> = { pazartesi: 0, sali: 1, carsamba: 2, persembe: 3, cuma: 4, cumartesi: 5, pazar: 6 };
  return addDays(weekMonday, idx[gun] ?? 0);
}

export const CUTOFF_HOURS = 12; // K-05

export function slotStartMs(slot: { tarih: string; baslangic: string }) {
  return localToMs(slot.tarih, slot.baslangic);
}
export function slotCutoffMs(slot: { tarih: string; baslangic: string }) {
  return slotStartMs(slot) - CUTOFF_HOURS * 3600_000;
}

/** K-11: Pzt–Cmt 09:00–20:00. */
export function inCallHours(ms: number): boolean {
  const p = parts(ms);
  if (p.dow === 0) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 9 * 60 && mins < 20 * 60;
}

/** K-11 dışındaysa en yakın uygun arama anı. */
export function nextCallableMs(ms: number): number {
  let t = ms;
  for (let i = 0; i < 24 * 8; i++) {
    if (inCallHours(t)) return t;
    const p = parts(t);
    if (p.dow === 0 || p.hour >= 20) t = localToMs(addDays(p.date, 1), "09:00");
    else if (p.hour < 9) t = localToMs(p.date, "09:00");
    else t += 3600_000;
  }
  return t;
}

export function fmtShort(iso: string): string {
  const ms = isoToMs(iso);
  const p = parts(ms);
  return `${GUN_ADI_TR[GUNLER[p.dow]].slice(0, 3)} ${p.hm}`;
}

export function fmtDateTr(date: string): string {
  const ms = localToMs(date, "12:00");
  const p = parts(ms);
  return `${p.day} ${AYLAR[p.month]} ${GUN_ADI_TR[GUNLER[p.dow]]}`;
}
