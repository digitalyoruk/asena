// Kural tabanlı dedektör (sert durdurma, global kesmeler, onay sınıflandırıcı, tarih ayrıştırma).
import { norm } from "./guardrails";

export type Signal =
  | "basvuru_itirazi" | "kart_aldim" | "vefat" | "ulasilamaz" | "zorlama" | "tehdit"
  | "insan_talebi" | "robot_mu" | "dolandirici_mi" | "hassas_veri" | "adres_degisikligi" | "baskasina_teslim" | "vekalet"
  | "aramayin" | "prompt_injection" | "kapsam_disi" | "kampanya" | "kufur" | "kimlik_sorunu" | "baglanti_koptu"
  | "yanlis_numara" | "ucuncu_kisi" | "telefon_devri" | "kayit_istemiyor" | "musait_degil" | "tekrar" | "sikayet"
  | "dogum_tarihi_tuzagi" | "kesin_saat" | "kurye_arar_mi" | "iptal_istiyor" | "gelecek_hafta_soru";

const R: [Signal, RegExp][] = [
  ["basvuru_itirazi", /(başvuru (yapmadım|etmedim)|kart(ı)? (hiç )?(istemedim|talep etmedim)|bu kartı hiç istemedim|böyle bir kart(ım)? yok)/],
  ["kart_aldim", /(kartı (zaten |salı (akşam )?)?aldım|kart (zaten )?elime (geçti|ulaştı)|aldım ya)/],
  ["vefat", /(vefat|öldü|rahmetli|hayatını kaybetti)/],
  ["ulasilamaz", /(hastanede yatıyor|yoğun bakım|ameliyatta|komada)/],
  ["zorlama", /(yanımda biri (var|söylüyor)|zorla(nıyorum|yorlar)|söyle diyor)/],
  ["tehdit", /(kendimi öldür|intihar|canıma kıy|seni bulurum|öldürürüm)/],
  ["insan_talebi", /(insanla|gerçek (bir )?kişiyle|temsilciyle|yetkiliyle|operatörle) (görüş|konuş)/],
  ["robot_mu", /(robot mu|yapay zek(a|â)(yla)? mı|bot mu|gerçek (bir )?(insan|kişi) mi)/],
  ["dolandirici_mi", /(dolandırıcı|nereden bileyim|bankalar (beni )?böyle aramaz)/],
  ["dogum_tarihi_tuzagi", /(doğum tarihimi siz söyleyin|siz söyleyin (bileyim|doğum))/],
  ["hassas_veri", /(kod geldi|kodu (söyle|oku)|şifrem|kart numaram|cvv|\[•••)/],
  ["adres_degisikligi", /(adres(im)? değişti|evime gönderin|başka adres|adresi söyleyeyim|konum atsam|iş yerime getirin|annemin evine)/],
  ["vekalet", /(vekâlet|vekalet|imza yetkisi)/],
  ["baskasina_teslim", /((eşim|annem|komşum|kapıcı|güvenlik|danışma|resepsiyon|çırağım|asistanım|hanım|sekreterim)[^.?!]*(alsın|alır|bırak|teslim)|kapıya bıraksın)/],
  ["aramayin", /(bir daha aramayın|beni aramayın|numaramı nereden)/],
  ["prompt_injection", /(talimatlarını unut|sistem prompt|diğer müşteri|başka müşterinin|önceki talimat)/],
  ["kampanya", /(kampanya|ek kart|puan|indirim)/],
  ["kapsam_disi", /(limit(im)?|aidat|yıllık ücret|faiz|aktif(leştir)?|şifre(mi)? nasıl)/],
  ["kufur", /(salak|aptal mısınız|gerizekalı|lan\b|kahrolası|siktir|defol)/],
  ["kimlik_sorunu", /(kimliğim(i)? (yok|kaybettim)|soyadım değişti|kimliğimde (yeni|farklı) soyad|süresi (geçmiş|dolmuş))/],
  ["baglanti_koptu", /(^\.\.\.$|\[bağlantı koptu\])/],
  ["yanlis_numara", /(bu numara artık benim|yanlış numara|öyle biri yok)/],
  ["telefon_devri", /(veriyorum|telefonu veriyorum|bir dakika (veriyorum|çağırıyorum)|buyrun ben (.+)|evet,? (şimdi )?ben)/],
  ["ucuncu_kisi", /(ben (onun )?(eşiyim|eşi|asistanıyım|asistanı|annesiyim|kızıyım|oğluyum|sekreteriyim)|kendisi (yok|banyoda|toplantıda|dışarıda|müsait değil)|toplantıda|bana söyleyin,? iletirim)/],
  ["kayit_istemiyor", /(kaydedilmesini istemiyorum|kayıt istemiyorum)/],
  ["musait_degil", /(şu an müsait değilim|sonra arayın|daha sonra arar mısınız|şimdi konuşamam)/],
  ["tekrar", /(tekrar eder misiniz|anlamadım|duyamadım|ne dediniz|pazartesi mi dediniz)/],
  ["sikayet", /(gelmedi|evdeydim|haber vermedi|kimse gelmedi|kaba|yan apartman|almamış|zil (bile )?çalmadı|aptal mı sanıyorsunuz)/],
  ["kesin_saat", /(kesin saat|saat \d|\d{1,2}[:.]\d{2}'?(te|ta|de|da)? gelsin|14:30)/],
  ["kurye_arar_mi", /(kurye (gelmeden|gelince) (önce )?(arar|haber))/],
  ["iptal_istiyor", /(kartı istemiyorum|iptal edin)/],
  ["gelecek_hafta_soru", /(gelecek hafta kesin)/],
];

export function detect(text: string): Signal[] {
  const s = norm(text);
  return R.filter(([, re]) => re.test(s)).map(([k]) => k);
}

export const HARD_STOPS: Signal[] = ["basvuru_itirazi", "kart_aldim", "vefat", "ulasilamaz", "zorlama", "tehdit"];

// ---------------------------------------------------------------- onay sınıflandırıcı (RF-24, EC-60)
const BELIRSIZ = /(olur ya|bakarız|tamam tamam|inşallah|herhalde|hallederiz|neyse|bir bakayım|sanırım|galiba|belki|duruma göre)/;
const KESIN = /(^|\b)(evet|onaylıyorum|tamam,? onaylıyorum|orada olacağım|evde olacağım|kesinlikle|uygun,? onaylıyorum|evet,? orada)/;
const HAYIR = /(^|\b)(hayır|olmaz|uygun değil|istemiyorum|yokum|olamam|evde olmayacağım|maalesef)/;

export function classifyConsent(text: string): "kesin_evet" | "belirsiz" | "hayir" {
  const s = norm(text);
  if (BELIRSIZ.test(s)) return "belirsiz";
  if (HAYIR.test(s)) return "hayir";
  if (KESIN.test(s)) return "kesin_evet";
  return "belirsiz";
}

/** Slot teklifine cevap: kabul / ret / kısmi ("11'e kadar evdeyim"). */
export function classifyOffer(text: string): { kind: "kabul" | "ret" | "kismi" | "belirsiz"; until?: string; from?: string } {
  const s = norm(text);
  const until = s.match(/(\d{1,2})(?::(\d{2}))?'?(e|a|ye|ya)? kadar/);
  if (until) return { kind: "kismi", until: `${until[1].padStart(2, "0")}:${until[2] ?? "00"}` };
  const from = s.match(/(\d{1,2})'?(ten|tan|den|dan) sonra/);
  if (from && /evde|ordayım|adresteyim|olurum/.test(s)) return { kind: "kismi", from: `${from[1].padStart(2, "0")}:00` };
  if (/(uygun değil|olmaz|evde olmuyorum|yokum|olamam|hiç uymuyor|maalesef)/.test(s)) return { kind: "ret" };
  if (/(uygun|olur|tamam|evet|evdeyim|oradayım|ayarlayalım|perşembe|cuma)/.test(s)) return { kind: "kabul" };
  return { kind: "belirsiz" };
}

export function isYes(text: string) {
  return /(^|\b)(evet|benim|buyrun|ta kendisi|evet benim|doğru)/.test(norm(text)) && !/(değil|hayır)/.test(norm(text));
}

// ---------------------------------------------------------------- doğum tarihi ayrıştırma (EC-63)
const AY: Record<string, number> = { ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12 };
const BIRLER: Record<string, number> = { bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9 };
const ONLAR: Record<string, number> = { on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90 };

function wordsToNumbers(s: string): string {
  return s.replace(/(bin dokuz yüz|iki bin)\s*/g, (m) => (m.startsWith("bin") ? "19" : "20"))
    .replace(/\b(on|yirmi|otuz|kırk|elli|altmış|yetmiş|seksen|doksan)(\s+(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz))?\b/g, (_m, o, _x, b) => String(ONLAR[o] + (b ? BIRLER[b] : 0)))
    .replace(/\b(bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz)\b/g, (m) => String(BIRLER[m]));
}

/** "14 Mart 1988", "on dört mart seksen sekiz", "14.03.1988" → "1988-03-14" */
export function parseBirthDate(text: string): string | null {
  let s = wordsToNumbers(norm(text));
  s = s.replace(/(19|20)\s+(\d{2})\b/g, "$1$2");
  let d: number | undefined, m: number | undefined, y: number | undefined;
  const named = s.match(/(\d{1,2})\s*(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)\w*\s*(\d{2,4})/);
  if (named) { d = +named[1]; m = AY[named[2]]; y = +named[3]; }
  else {
    const num = s.match(/(\d{1,2})[./\s-]+(\d{1,2})[./\s-]+(\d{2,4})/);
    if (num) { d = +num[1]; m = +num[2]; y = +num[3]; }
  }
  if (!d || !m || !y) return null;
  if (y < 100) y += y > 30 ? 1900 : 2000;
  if (m > 12 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
