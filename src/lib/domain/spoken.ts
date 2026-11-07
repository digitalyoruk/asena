// Saat ve aralıkların doğal Türkçe söylenişi (asena/karakter.md: "09:00–13:00" → "sabah dokuzla öğlen bir arası").
import { dayKey, GUN_ADI_TR } from "./time";

const SAYI = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "on bir", "on iki"];

function hour12(h: number) {
  const x = h % 12;
  return x === 0 ? 12 : x;
}

function period(h: number): string {
  if (h < 12) return "sabah";
  if (h <= 13) return "öğlen";
  if (h < 17) return "öğleden sonra";
  return "akşam";
}

function word(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  const base = SAYI[hour12(h)];
  return m === 30 ? `${base} buçuk` : m ? `${base} ${m}` : base;
}

/** "ile" eki (dokuzla, ikiyle, altıyla, birle, üçle). */
export function ileEki(w: string): string {
  const vowels = w.match(/[aeıioöuü]/g) ?? ["a"];
  const last = vowels[vowels.length - 1];
  const back = "aıou".includes(last);
  const endsVowel = /[aeıioöuü]$/.test(w);
  return w + (endsVowel ? "y" : "") + (back ? "la" : "le");
}

/** "sabah dokuzla öğlen bir arası" */
export function spokenRange(baslangic: string, bitis: string): string {
  const hs = Number(baslangic.split(":")[0]);
  const he = Number(bitis.split(":")[0]);
  const ps = period(hs);
  const pe = period(he);
  const start = `${ps} ${ileEki(word(baslangic))}`;
  const end = ps === "sabah" && pe !== "sabah" ? `${pe} ${word(bitis)}` : word(bitis);
  return `${start} ${end} arası`;
}

export function spokenDay(tarih: string): string {
  return GUN_ADI_TR[dayKey(tarih)];
}

/** "perşembe sabah dokuzla öğlen bir arası" */
export function spokenSlot(s: { tarih: string; baslangic: string; bitis: string }): string {
  return `${spokenDay(s.tarih)} ${spokenRange(s.baslangic, s.bitis)}`;
}

/** Kısa saat sözü: "11:00" → "on bir" */
export function spokenHour(hm: string): string {
  return word(hm);
}
