// Case demo seti ve kütüphane seed'leri (bilgi-havuzu'ndan kopyalanır: `pnpm seed:sync`).
import musteriler from "./musteriler.json";
import takvim from "./kurye-takvimi.json";
import arketipler from "./arketipler.json";
import magduriyetler from "./magduriyetler.json";
import profiller from "./musaitlik-profilleri.json";
import sapmalar from "./sapmalar.json";
import type { CharacterAssignment, CharacterLibrary, CourierSlot, Customer, KbDoc, Settings } from "../domain/types";
import { dateForDay } from "../domain/time";

export const DEFAULT_WEEK_MONDAY = takvim.simulasyon.hafta_pazartesi; // V-09
export const DEFAULT_NOW = "2026-11-11T10:00:00+03:00"; // çarşamba 10:00 (V-09)

export function characterLibrarySeed(): CharacterLibrary {
  return structuredClone({
    arketipler: arketipler.arketipler,
    magduriyetler: magduriyetler.magduriyetler,
    profiller: profiller.profiller,
    sapmalar: sapmalar.sapmalar,
  }) as CharacterLibrary;
}

/** M01–M08 için sabit karakterler (karakterler/README.md "Eski M01–M08 personaları"). */
export const CASE_CHARACTERS: Record<string, Omit<CharacterAssignment, "seed" | "elleDuzenlendi">> = {
  M01: { arketipId: "A01", magduriyetId: "G07", musaitlikProfilId: "P1", sapmaIds: ["S15"], ekNot: "Perşembe sabahı tercih eder; cuma öğleden sonra okul çıkışı var." },
  M02: { arketipId: "A02", magduriyetId: "G00", musaitlikProfilId: "P3", sapmaIds: ["S05"], ekNot: "Kasap; perşembe sabah toptancıda, cuma öğleden sonra dükkanda." },
  M03: { arketipId: "A03", magduriyetId: "G00", musaitlikProfilId: "P1", sapmaIds: ["S13", "S05"], ekNot: "Her zaman evde; slot yoksa komşuya bırakılmasını ister." },
  M04: { arketipId: "A04", magduriyetId: "G00", musaitlikProfilId: "P3", sapmaIds: ["S03", "S12"], ekNot: "Kesin saat ister (14:30)." },
  M05: { arketipId: "A05", magduriyetId: "G05", musaitlikProfilId: "P3", sapmaIds: ["S05", "S04"], ekNot: "Hemşire; perşembe öğleden sonra hastanede, servis girişine inebilir." },
  M06: { arketipId: "A06", magduriyetId: "G00", musaitlikProfilId: "P2", sapmaIds: ["S01", "S05"], ekNot: "Telefonu eşi Gülay Hanım açar, sonra verir." },
  M07: { arketipId: "A07", magduriyetId: "G02", musaitlikProfilId: "P2", sapmaIds: ["S11"], ekNot: "Cuma sabah evden çalışıyor." },
  M08: { arketipId: "A08", magduriyetId: "G00", musaitlikProfilId: "P2", sapmaIds: ["S06"], ekNot: "Varyant B: kendisi açar, asistanı Derya'nın almasını ister." },
};

/** Case müşterileri için hazır varyantlar (musteriler/README.md). */
export const CASE_VARIANTS: Record<string, { ad: string; sapmaIds: string[] }[]> = {
  M02: [{ ad: "C: 'Bir daha aramayın' (EC-72)", sapmaIds: ["S09"] }],
  M03: [{ ad: "C: 'Bu kartı hiç istemedim' (EC-30)", sapmaIds: ["S07"] }],
  M05: [{ ad: "C: Soyadı değişti (EC-44)", sapmaIds: ["S10"] }],
  M06: [{ ad: "C: Eşi 'hastanede yatıyor' der (EC-13)", sapmaIds: ["S01", "S19"] }],
  M07: [{ ad: "C: 'Kartı salı akşam aldım' (EC-31)", sapmaIds: ["S08"] }],
  M08: [{ ad: "A: Asistanı Derya açar → geri arama", sapmaIds: ["S01"] }, { ad: "B: Kendisi açar, vekâlet ister", sapmaIds: ["S06"] }],
};

const HITAP: Record<string, "Hanım" | "Bey"> = { M01: "Hanım", M02: "Bey", M03: "Hanım", M04: "Bey", M05: "Hanım", M06: "Bey", M07: "Hanım", M08: "Bey" };

export function caseCustomers(nowIso: string, withCharacters = true): Customer[] {
  return musteriler.musteriler.map((m) => {
    const addrId = `${m.id}-A1`;
    const c: Customer = {
      id: m.id,
      adSoyad: m.ad_soyad,
      hitapEki: HITAP[m.id] ?? null,
      telefon: normalizePhone(m.telefon),
      dogumTarihi: m.dogum_tarihi,
      adresler: m.kayitli_adresler.map((a, i) => ({ id: `${m.id}-A${i + 1}`, tip: a.tip as "Ev" | "İş yeri", ilce: a.ilce, dogrulanmis: a.dogrulanmis })),
      teslimAdresId: addrId,
      kart: { konum: (m.kart_konumu ?? "depoda") as Customer["kart"]["konum"], basarisizTeslim: m.basarisiz_teslim_sayisi ?? 1, sonDeneme: "sali" },
      durum: "aranacak",
      etiketler: ["case-seti"],
      createdAt: nowIso, updatedAt: nowIso,
    };
    if (withCharacters) c.karakter = { ...CASE_CHARACTERS[m.id], seed: "case-sabit", elleDuzenlendi: true };
    return c;
  });
}

export const CASE_ORDER = musteriler.varsayilan_arama_sirasi;

export function caseSlots(weekMonday: string): CourierSlot[] {
  return takvim.slotlar.map((s) => ({
    id: s.id, ilce: s.ilce, tarih: dateForDay(weekMonday, s.gun), baslangic: s.baslangic, bitis: s.bitis,
    kapasite: s.kapasite, aktif: true,
  }));
}

export function normalizePhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.startsWith("90")) return `+${d}`;
  if (d.startsWith("0")) return `+90${d.slice(1)}`;
  return `+90${d}`;
}

export function defaultSettings(): Settings {
  return {
    engine: { url: "http://127.0.0.1:8787", token: null },
    llm: { anlama: "alibayram/kumru:latest", konusma: "alibayram/kumru:latest", musteri: "alibayram/kumru:latest", numCtx: 8192, understanding: "hibrit", speech: "llm", customer: "llm" },
    tts: { asena: "ema", musteri: "antalia", rate: 1, phoneFilter: false, pitchVariety: true },
    listenMode: "stream",
    behavior: { fillerLevel: 1, backchannel: true, maxTurns: 28, silenceTimeoutMs: 5000, turnGapMs: 250 },
    simulation: { weekMonday: DEFAULT_WEEK_MONDAY, now: DEFAULT_NOW, autoCall: false },
    demo: { stopAfterEach: false, difficulty: "gercekci", seed: "demo-2026-11-07-1", strategy: "kitlik" },
  };
}

export const DEFAULT_KB_MARKDOWN = `# Kurum Bilgisi

> Buraya yazılanlar yasal kuralları geçersiz kılamaz. Çelişki olursa Asena yasal kuralı uygular.

## 1. Kurum
- **Kurum adı:** Asena Demo Bank
- **Ticaret unvanı:** Asena Demo Bank A.Ş.

## 2. Resmi iletişim kanalları
- **Mobil uygulama adı:** Asena Demo Bank mobil uygulaması (App Store / Google Play)
- **Web sitesi:** asenademobank.com.tr
- **Arayan numara:** 0850 000 00 00
- **Müşterinin bizi arayabileceği numara:** 0850 000 00 00
- **KVKK aydınlatma metni adresi:** asenademobank.com.tr/kvkk

## 3. Kart teslim politikası
- Yeniden teslim ücreti: Ücretsiz
- Teslim belgesi: T.C. kimlik kartı, süresi geçerli pasaport, yeni tip sürücü belgesi
- Alternatif teslim noktası: Yok
- Bu hafta teslim alamayanlar için süreç: Gelecek hafta bölgeye ilk kurye çıkışında öncelikli aranır

## 3b. Operasyon anahtarları
\`\`\`yaml
on_bilgi_sms: true
randevu_teyit_sms: true
hatirlatma_sms: true
kurye_yolda_sms: false
kurye_varista_arar: false
kurye_adi_paylas: false
sesli_mesaj_birak: false
ek_dil: null
insan_geri_arama_sla_saat: 4
gelen_arama_karsilanir: true
\`\`\`

## 4. Sık sorulan sorular
- **Kartım ne zaman aktif olur?** Teslimden sonra mobil uygulamadan aktifleştirebilirsiniz.
- **Kart şifremi nasıl belirlerim?** Mobil uygulamadan belirleyebilirsiniz. Şifrenizi kimseyle paylaşmayın.
- **Yıllık ücret var mı?**
- **Limitim ne kadar?** Limit bilgisini mobil uygulamanızda görebilirsiniz.

## 5. Eskalasyon
- İnsan desteği: Operasyon ekibi iş saatleri içinde 4 saat içinde geri arar
- Şikayet kanalı: Uygulama > Destek > Şikayet
`;

export function defaultKb(nowIso: string): KbDoc[] {
  return [{ id: "kb-1", title: "Kurum bilgisi (şablon)", markdown: DEFAULT_KB_MARKDOWN, active: true, updatedAt: nowIso }];
}
