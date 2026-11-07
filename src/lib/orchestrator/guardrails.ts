// Guardrail katmanı (yasal/02 §D): girdi maskeleme, çıktı filtresi (cümle bazlı), not filtresi.
// Her kural bir RF kimliğine bağlıdır; tests/guardrails.test.ts her RF için en az bir vaka içerir.

export type Violation = { rf: string; reason: string };

// ---------------------------------------------------------------- yardımcılar
export function norm(s: string) {
  return s.toLocaleLowerCase("tr").replace(/[’']/g, "'");
}

export function luhn(digits: string) {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

const SAYI_KELIME = "(sıfır|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz)";

// ---------------------------------------------------------------- girdi filtresi (RF-01, RF-04, EC-93)
export type InputMask = { text: string; masked: boolean; kinds: string[] };

/**
 * Müşteri metnindeki kart numarası (Luhn), kod/şifre/OTP okumalarını maskeler. LLM'e ve transcript'e maskeli hali gider.
 * `allowDate`: DOGRULAMA durumunda tarih biçimli rakamlar kod sayılmaz (ayrıca doğum tarihi ayrı maskelenir).
 */
export function maskInput(text: string, opts: { allowDate?: boolean } = {}): InputMask {
  let out = text; const kinds: string[] = [];
  // 13-19 haneli kart numarası (boşluk/tire ile)
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) { kinds.push("kart_no"); return "[•••• kart no]"; }
    return m;
  });
  const ctx = /(kod|şifre|sifre|parola|otp|cvv|cvc|pin|sms)/i.test(out);
  // "4-8-1-9", "4 8 1 9", "481923"
  out = out.replace(/\b\d(?:[\s\-.]+\d){2,7}\b|\b\d{3,8}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    if (opts.allowDate && /^\d{1,2}[./ -]\d{1,2}[./ -]\d{2,4}$/.test(m.trim())) return m;
    if (opts.allowDate && /^(19|20)\d{2}$/.test(d)) return m;
    if (ctx || /[\s\-.]/.test(m) || d.length >= 4) {
      if (!ctx && d.length === 4 && /^(19|20)\d{2}$/.test(d)) return m; // yıl
      kinds.push("kod"); return "[•••]";
    }
    return m;
  });
  // kelimeyle okunan kod: "dört sekiz bir dokuz"
  const wordSeq = new RegExp(`(?:${SAYI_KELIME}[\\s,-]+){3,}${SAYI_KELIME}`, "giu");
  if (ctx || !opts.allowDate) {
    out = out.replace(wordSeq, () => { kinds.push("kod"); return "[•••]"; });
  }
  if (/(şifrem|şifremi|parolam|cvv|son kullanma tarihi)/i.test(text) && !kinds.length) kinds.push("hassas_ifade");
  return { text: out, masked: kinds.length > 0, kinds };
}

// ---------------------------------------------------------------- çıktı filtresi
export type OutputContext = {
  verified: boolean;
  bookingConfirmed: boolean;
  customer: { adSoyad: string; dogumTarihi?: string; acikAdresler?: string[]; ilceler?: string[]; telefon?: string };
  kb: { kurye_yolda_sms: boolean; kurye_varista_arar: boolean; officialNumbers: string[]; officialWeb?: string };
};

const AYLAR = "(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)";

/** Bir Asena cümlesini kontrol eder. `template` = şablondan gelen yasal cümle (doğrulanmış metin, RF-05 istisnası açılış güvencesi). */
export function checkOutput(sentence: string, ctx: OutputContext, template = false): Violation[] {
  const s = norm(sentence);
  const v: Violation[] = [];
  const add = (rf: string, reason: string) => v.push({ rf, reason });

  // RF-05: doğrulama öncesi ürün/işlem kelimeleri (şablon açılış güvencesi hariç)
  if (!ctx.verified && !template && /\b(kart|kredi|teslim|kurye|hesab|hesap|randevu|müşterimiz|borç|limit)/.test(s)) {
    add("RF-05", "Doğrulama öncesi ürün/işlem kelimesi");
  }
  // RF-03: kayıtlı verinin sesli okunması
  const dob = ctx.customer.dogumTarihi;
  if (dob) {
    const [y, m, d] = dob.split("-").map(Number);
    const ay = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık"][m - 1];
    if (s.includes(String(y)) || new RegExp(`\\b${d}\\s*${ay}`).test(s) || new RegExp(`\\b0?${d}[./]0?${m}\\b`).test(s)) add("RF-03", "Kayıtlı doğum tarihi okunuyor");
  }
  if (new RegExp(`\\b\\d{1,2}\\s*${AYLAR}\\s*(19|20)?\\d{2}`).test(s) && !template) add("RF-03", "Tarih okunuyor");
  for (const a of ctx.customer.acikAdresler ?? []) if (a && s.includes(norm(a).slice(0, 12))) add("RF-03", "Açık adres okunuyor");
  if (!ctx.verified) for (const i of ctx.customer.ilceler ?? []) if (i && s.includes(norm(i))) add("RF-03", "Doğrulama öncesi ilçe söyleniyor");
  const tel = ctx.customer.telefon?.replace(/\D/g, "").slice(-7);
  if (tel && s.replace(/\D/g, "").includes(tel)) add("RF-03", "Telefon numarası okunuyor");

  if (!template) {
    // RF-01: gizli bilgi sorma
    if (/(şifre|parola|pin|cvv|cvc|son kullanma|kart (numara|no)|otp|doğrulama kodu|sms kodu|gelen kod)[^.?!]*(söyle|ver|paylaş|oku|tuşla|ilet|nedir|\?)/.test(s)) add("RF-01", "Gizli bilgi isteniyor");
    // RF-02: anne kızlık soyadı / TCKN ile doğrulama
    if (/(anne(nizin)? kızlık|tc kimlik|t\.c\.|kimlik numara|doğum yeri)/.test(s)) add("RF-02", "Kimlik bilgisiyle doğrulama");
    // RF-08: adres/telefon değişikliği kabul
    if (/(yeni adres|adresinizi (değiştir|güncelle)|adres(i)? (alayım|kaydedeyim|not alayım)|numaranızı (güncelle|değiştir))(?!.*(yapamıyorum|alamıyorum|değiştiremiyorum|mümkün değil))/.test(s)) add("RF-08", "Telefonda adres/iletişim değişikliği");
    // RF-07/RF-28: başkasına teslim kabulü
    if (/(eşiniz|komşunuz|kapıcı|güvenlik|resepsiyon|asistanınız|sekreteriniz|annen|anneniz|çırağınız|vekil)[^.?!]*(alabilir|teslim alsın|bırakabilir|bırakırız|bırakalım|imzalayabilir)/.test(s) && !/(alamaz|bırakamı|yapamıyoruz|edemiyoruz|mümkün değil)/.test(s)) add("RF-07", "Üçüncü kişiye teslim kabulü");
    if (/vekâlet|vekalet/.test(s) && !/(yapamıyoruz|kabul edemiyoruz|mümkün değil|alamıyoruz)/.test(s)) add("RF-28", "Vekâlet kabulü");
    // RF-10: insan olduğunu iddia
    if (/(ben (de )?(bir )?(insanım|gerçek (bir )?(kişi|insan)(yim)?)|insan(ım|ız) ben|robot değilim|yapay zeka değilim)/.test(s)) add("RF-10", "İnsan olduğunu iddia");
    if (/(kumru|vngrs|dil modeli(yim)?|language model|qwen|ollama)/.test(s)) add("RF-10", "Model kimliği sızıntısı");
    // RF-12: kesin saat sözü ve teyitsiz "oluşturuldu"
    if (/\b([01]?\d|2[0-3])[:.][0-5]\d\b/.test(s) || /\bsaat\s+(\d{1,2}|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on)\s*('?(de|da|te|ta|gibi)|\b)(?!.*arası)/.test(s)) add("RF-12", "Kesin saat sözü");
    if (!ctx.bookingConfirmed && /(randevu(nuz)?|teslimat(ınız)?)\s*(oluşturuldu|oluştu|ayarlandı|kesinleşti|tamamlandı|kaydedildi)/.test(s)) add("RF-12", "Teyitsiz randevu sözü");
    // RF-13: ücret/limit uydurma
    if (/(yıllık ücret|aidat|faiz oranı|limitiniz)\s*[^.?!]*\d/.test(s)) add("RF-13", "Ücret/limit bilgisi uydurma");
    // RF-14: satış/pazarlama
    if (/(kampanya|ek kart|limit artış|kredi (çek|kullan|teklif)|fırsat|indirim|puan kazan|avantaj)/.test(s)) add("RF-14", "Satış/pazarlama ifadesi");
    // RF-15: ücret/ödeme isteme
    if (/(ücret(i)?\s*(öde|yatır|alın|tahsil|var)|ödeme (yap|bilgi)|iban|havale|eft\b|tl (öde|yatır))/.test(s) && !/ücret(i)? yok|ücretsiz/.test(s)) add("RF-15", "Ücret/ödeme ifadesi");
    // RF-16: link / başka numara / uygulama indirme
    if (/(https?:\/\/|www\.|\.com\b|\.net\b|bit\.ly|linke tıkla|bağlantıya tıkla|whatsapp|telegram|apk)/.test(s) && !(ctx.kb.officialWeb && s.includes(norm(ctx.kb.officialWeb)))) add("RF-16", "Link/resmi olmayan kanal");
    const nums = s.match(/\b0?\s?8\d{2}[\s\d]{6,12}|\b0?5\d{2}[\s\d]{7,10}/g) ?? [];
    for (const n of nums) if (!ctx.kb.officialNumbers.some((o) => o.replace(/\D/g, "").endsWith(n.replace(/\D/g, "").slice(-7)))) add("RF-16", "Resmi olmayan numara");
    // RF-17: aciliyet/tehdit
    if (/(iptal olacak|iptal edilecek|kapatılacak|hemen karar|son şans|aksi (halde|takdirde)|kaybedersiniz|acele etmelisiniz|yasal işlem)/.test(s)) add("RF-17", "Aciliyet/tehdit dili");
    // RF-18: "bana güvenin" ısrarı
    if (/(bana güven(in|ebilirsiniz)|güvenmek zorunda|inanın bana)/.test(s)) add("RF-18", "Güven ısrarı");
    // RF-25 sesli mesajda ayrıntı — sesli mesaj şablonu ayrı kontrol edilir (voicemailOk)
    // RF-32: yapılmayan hizmet sözü
    if (!ctx.kb.kurye_yolda_sms && /(yola çıkınca|yola çıktığında)[^.?!]*(mesaj|sms|haber)/.test(s)) add("RF-32", "Kurye yolda SMS sözü (kapalı)");
    if (!ctx.kb.kurye_varista_arar && /kurye[^.?!]*(sizi arayacak|gelmeden (önce )?arar|varınca arar|geldiğinde (sizi )?arar)/.test(s) && !/aramayabilir|aramıyor/.test(s)) add("RF-32", "Kurye arar sözü (kapalı)");
    // RF-33: kurye kodu okuma veya kod isteme
    if (/\b\d{4}\b/.test(s) && /kod/.test(s)) add("RF-33", "Kod sesli okunuyor");
    if (/(kodu|kod)[^.?!]*(bana|kuryeye) (söyle|ilet|okuyun|verin)/.test(s) && !/(söylemeyin|vermeyin|paylaşmayın)/.test(s)) add("RF-33", "Müşteriden kod isteniyor");
    // RF-09: başka ilçeye yazma sözü
    if (/(başka (bir )?ilçe|farklı (bir )?ilçe)[^.?!]*(gönder|teslim ed|yazabil)/.test(s) && !/(yapamıyorum|edemiyoruz|mümkün değil)/.test(s)) add("RF-09", "Başka ilçeye teslim sözü");
    // RF-19: itiraz sonrası ısrar
    if (/(yine de|gene de) (randevu|teslim)/.test(s)) add("RF-19", "İtiraza rağmen ısrar");
    // RF-26: vefat sonrası belge isteme
    if (/(ölüm belgesi|vefat belgesi|rapor gönder|belge (gönder|iste))/.test(s)) add("RF-26", "Belge/kanıt isteme");
  }
  return v;
}

/** Sesli mesaj şablonu: ürün, kart, teslimat, adres yok (RF-25). */
export function voicemailOk(text: string): boolean {
  return !/(kart|teslim|kurye|adres|randevu|kredi)/i.test(text);
}

/** LLM'in ürettiği metni cümlelere böler (., ?, !, …). */
export function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
}

// ---------------------------------------------------------------- not filtresi (RF-31)
export function checkNote(text: string): Violation[] {
  const s = norm(text);
  const v: Violation[] = [];
  if (/(hastane|hasta(lık)?|ameliyat|yoğun bakım|kanser|tedavi|ilaç|engelli|işitme engel|tanı|teşhis|depresyon|hamile)/.test(s)) v.push({ rf: "RF-31", reason: "Sağlık bilgisi" });
  if (/\b\d{4,}\b/.test(s) || /\b\d(?:[\s-]\d){3,}\b/.test(s)) v.push({ rf: "RF-31", reason: "Kod/kart numarası" });
  if (/(mah(alle)?\.?\s|sok(ak)?\.?\s|cad(de)?\.?\s|bulvar|apt\.?|apartman|daire|kat:|no:|blok)/.test(s)) v.push({ rf: "RF-31", reason: "Adres metni" });
  if (/(eşi|annesi|babası|kızı|oğlu|asistanı|sekreteri|komşusu)\s+[a-zçğıöşü]+\s+(hanım|bey)/.test(s)) v.push({ rf: "RF-31", reason: "Üçüncü kişinin kimliği" });
  if (/(din|mezhep|siyasi|parti üyesi)/.test(s)) v.push({ rf: "RF-31", reason: "Özel nitelikli veri" });
  return v;
}
