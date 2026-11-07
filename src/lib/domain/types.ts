// Alan modeli. Kaynak: bilgi-havuzu/urun/dinamik-veri.md, musteri-notlari-ve-planlama.md,
// toplu-demo-ve-karar-akisi.md, asena/arac-tanimlari.md

export type CustomerStatus =
  | "aranacak" | "aranıyor" | "randevu_verildi" | "bekleme_listesi" | "geri_arama" | "ulasilamadi"
  | "dogrulama_basarisiz" | "ucuncu_kisi" | "kart_talep_itirazi" | "insana_aktarildi"
  | "musteri_kayit_istemedi" | "teslimat_donduruldu" | "aranmasin" | "yanlis_numara" | "teslim_engeli";

export type CardLocation = "basimda" | "depoda" | "kuryede" | "teslim_edildi" | "bloke" | "imha";
export type AddressType = "Ev" | "İş yeri";

export type Address = { id: string; tip: AddressType; ilce: string; acikAdres?: string; dogrulanmis: boolean };

export type CharacterAssignment = {
  arketipId: string; magduriyetId: string; musaitlikProfilId: string; sapmaIds: string[];
  ekNot?: string; seed: string; elleDuzenlendi: boolean;
};

export type Customer = {
  id: string;
  adSoyad: string;
  hitapEki?: "Hanım" | "Bey" | null; // V-35: cinsiyet kayıtta yok; hitap elle seçilir
  telefon: string;
  dogumTarihi: string; // demo_only (RF-02). Asena bağlamına hiçbir zaman girmez
  adresler: Address[];
  teslimAdresId: string;
  kart: { konum: CardLocation; basarisizTeslim: number; sonDeneme?: string };
  durum: CustomerStatus;
  karakter?: CharacterAssignment;
  etiketler?: string[];
  createdAt: string; updatedAt: string;
};

export type CourierSlot = {
  id: string; kurye?: string; ilce: string; tarih: string; baslangic: string; bitis: string;
  kapasite: number; aktif: boolean; not?: string;
};

export type Hold = { id: string; slotId: string; customerId: string; callId: string; expiresAt: number };
export type Booking = {
  id: string; slotId: string; customerId: string; createdAt: string; status: "aktif" | "iptal";
  adresTipi: AddressType; kismiMusaitlik?: { bitis: string }; kuryeKoduHash: string; callId?: string; iptalNedeni?: string;
};
export type WaitlistEntry = { id: string; customerId: string; ilce: string; reason: "kapasite_dolu" | "musteri_uygun_degil"; tercihNotu?: string; createdAt: string; status: "aktif" | "kapandi" };

export type NoteCategory = "musaitlik" | "tercih" | "iletisim" | "itiraz" | "guvenlik" | "teslim_engeli" | "kurye_notu" | "talep" | "genel";
export type NoteVisibility = "asena" | "internal" | "courier";
export type Note = {
  id: string; customerId: string; createdAt: string; updatedAt: string; author: "asena" | "operator" | "system";
  callId?: string; category: NoteCategory; visibility: NoteVisibility; text: string; pinned?: boolean;
  expiresAt?: string; linkedEc?: string; arsivlendi?: boolean;
};

export type ScheduleType =
  | "geri_arama" | "tekrar_deneme" | "insan_geri_arama" | "guvenlik_geri_arama" | "insan_inceleme"
  | "bekleme_listesi_arama" | "bekleme_listesi_kontrol" | "gelecek_hafta_arama" | "kurye_firmasi_inceleme"
  | "adres_degisikligi_takip" | "kayit_guncelleme_takip" | "link_kontrol"
  | "on_bilgi_sms" | "randevu_teyit_sms" | "hatirlatma_sms" | "kurye_yolda_sms";
export type Schedule = {
  id: string; customerId: string; type: ScheduleType; dueAt: string; slaDeadline?: string;
  status: "bekliyor" | "tamamlandi" | "iptal" | "gecikti"; channel: "ses" | "sms" | "insan" | "ic_islem";
  source: "asena" | "operator" | "system" | "musteri" | "ucuncu_kisi" | "baglanti_koptu";
  reason: string; createdAt: string; createdByCallId?: string; completedByCallId?: string; linkedEc?: string; uyari?: "BU_HAFTA_RISKLI";
};

export type FreezeReason = "basvuru_itirazi" | "teslim_kaydi_uyusmazligi" | "vefat_bildirimi" | "ulasilamaz_durum" | "musteri_iptal_talebi" | "zorlama_suphesi";
export type CustomerFlags = {
  aranmasin?: { since: string; reason: string };
  teslimat_donduruldu?: { since: string; reason: FreezeReason };
  guvenlik_incelemesi?: { since: string; ec: string };
  numara_gecersiz?: { since: string };
  iletisim_kanali?: "ses" | "yazili";
  dil?: "tr" | "en";
};

export type Attempt = { id: string; customerId: string; at: string; yon: "giden" | "gelen"; sonuc: "cevaplandi" | "cevapsiz" | "sesli_mesaj" | "mesgul" | "yanlis_numara"; callId?: string; outcome?: string };

export type SmsTemplate =
  | "on_bilgi" | "randevu_teyit" | "hatirlatma" | "kurye_yolda" | "bolge_dolu" | "bekleme_listesi"
  | "ulasilamadi" | "self_servis_link" | "ikinci_basarisiz" | "randevu_degisti" | "operator";
export type Sms = { id: string; customerId: string; at: string; template: SmsTemplate; body: string; status: "gonderildi"; decisionId?: string; callId?: string };

export type DecisionType =
  | "arama_sirasi" | "sira_guncellendi" | "atlandi" | "ertelendi" | "durum_gecisi" | "dogrulama" | "slot_sorgu"
  | "slot_teklif" | "hold" | "randevu" | "randevu_iptal" | "bekleme_listesi" | "plan" | "not" | "bayrak" | "sms"
  | "sert_durdurma" | "insana_aktarim" | "guardrail" | "degerlendirme" | "arac" | "anlama" | "sikayet" | "guvenlik";
export type Decision = {
  id: string; runId?: string; callId?: string; customerId?: string; at: string; seq: number;
  actor: "asena" | "sistem" | "operator" | "guardrail"; tip: DecisionType; ozet: string; gerekce: string;
  veri?: Record<string, unknown>; ref?: string[]; seviye: "bilgi" | "uyari" | "kritik";
};

export type Outcome =
  | "randevu_verildi" | "bekleme_listesi" | "geri_arama" | "ucuncu_kisi" | "dogrulama_basarisiz" | "kart_talep_itirazi"
  | "insana_aktarildi" | "musteri_kayit_istemedi" | "yanlis_numara" | "baglanti_koptu" | "teslimat_donduruldu"
  | "aranmasin" | "teslim_engeli";

export type CallRecord = {
  id: string; customerId: string; runId?: string; startedAt: string; endedAt?: string; outcome?: Outcome; summary?: string;
  slotId?: string; turns: number; evaluation?: Evaluation; yon: "giden" | "gelen"; ttfaMs?: number[];
};

export type EvalCheck = { id: string; label: string; status: "ok" | "uyari" | "hata"; detail: string; ref?: string };
export type Evaluation = { score: "ok" | "uyari" | "hata"; checks: EvalCheck[] };

export type RunStrategy = "kitlik" | "liste" | "rastgele";
export type Run = {
  id: string; createdAt: string; seed: string; strategy: RunStrategy; customerIds: string[]; order: string[];
  cursor: number; status: "hazir" | "calisiyor" | "duraklatildi" | "bitti" | "durduruldu";
  difficulty: Difficulty; callIds: Record<string, string>; results: Record<string, { outcome?: Outcome; slotId?: string; evaluation?: Evaluation; skipped?: string }>;
  finishedAt?: string;
};
export type Difficulty = "kolay" | "gercekci" | "zor";

export type Settings = {
  engine: { url: string; token: string | null };
  llm: { anlama: string; konusma: string; musteri: string; numCtx: number; understanding: "hibrit" | "kural"; speech: "llm" | "sablon"; customer: "llm" | "senaryo" };
  tts: { asena: "ema" | "antalia"; musteri: "ema" | "antalia"; rate: number; phoneFilter: boolean; pitchVariety: boolean };
  listenMode: "stream" | "bitince" | "sessiz";
  behavior: { fillerLevel: 0 | 1 | 2 | 3; backchannel: boolean; maxTurns: number; silenceTimeoutMs: number; turnGapMs: number };
  simulation: { weekMonday: string; now: string; autoCall: boolean };
  demo: { stopAfterEach: boolean; difficulty: Difficulty; seed: string; strategy: RunStrategy };
};

export type KbDoc = { id: string; title: string; markdown: string; active: boolean; updatedAt: string };

export type Arketip = { id: string; ad: string; ozet: string; konusma_tarzi: string; hitap: string; tempo: string; duygu: string; ses: { rate: number; pitch: number; noise?: string }; egilim_sapmalar: string[]; test: string };
export type Magduriyet = { id: string; ad: string; anlatim: string | null; yogunluk: number; dogru_tepki: string; yanlis_tepki: string | null; ec: string[] };
export type Pencere = { gunler: string[]; baslangic: string; bitis: string };
export type MusaitlikProfili = { id: string; ad: string; pencereler: Pencere[] };
export type Sapma = { id: string; ad: string; ref: string; sert_durdurma: boolean };
export type CharacterLibrary = { arketipler: Arketip[]; magduriyetler: Magduriyet[]; profiller: MusaitlikProfili[]; sapmalar: Sapma[] };
