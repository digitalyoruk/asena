// Simüle SMS şablonları (toplu-demo-ve-karar-akisi.md §5, edge-case-playbook EC-00c).
// Doğrulama öncesi / ulaşılamayan müşteriye giden şablonlarda gün, aralık, adres tipi YOK.
import type { KbConfig } from "../domain/kb";
import type { SmsTemplate } from "../domain/types";

export const PRE_VERIFICATION_TEMPLATES: SmsTemplate[] = ["on_bilgi", "ulasilamadi", "self_servis_link"];

export type SmsVars = { gun?: string; aralik?: string; adres_tipi?: string; kurye_kodu?: string; kimlik_listesi?: string };

export const SMS_TEMPLATES: Record<Exclude<SmsTemplate, "operator">, string> = {
  on_bilgi: "{banka}: Sizi bugün {resmi_numara} numarasından arayacağız. Sizden hiçbir şifre veya kod istemeyeceğiz.",
  randevu_teyit: "{banka}: Teslimatınız {gun} {aralik} arasında kayıtlı {adres_tipi} adresinize planlandı. Kart yalnız size, geçerli kimlikle ({kimlik_listesi}) teslim edilir. Kurye kapıda size {kurye_kodu} kodunu SÖYLEYECEK; kod tutmazsa kartı almayın. Siz kimseye kod söylemeyin. İptal/değişiklik: {uygulama} veya {resmi_numara}.",
  hatirlatma: "{banka}: Hatırlatma: teslimatınız yarın {aralik} arasında kayıtlı {adres_tipi} adresinize. Yanınızda geçerli kimliğiniz bulunsun.",
  kurye_yolda: "{banka}: Kuryemiz yola çıktı. Kapıda size SMS'teki kodu söyleyecek.",
  bolge_dolu: "{banka}: Bu hafta bölgenizdeki kurye teslimat zamanlarının tamamı doldu. Bir yer açılırsa veya gelecek hafta ilk uygun zamanda teslimatı planlamak için sizi arayacağız. Sizden hiçbir şifre veya kod istemeyeceğiz.",
  bekleme_listesi: "{banka}: Sizi bekleme listesine aldık. Bu hafta bir yer açılırsa sizi arayacağız; açılmazsa gelecek hafta ilk kurye çıkışından önce öncelikli olarak arayacağız.",
  ulasilamadi: "{banka}: Sizinle iletişime geçmeye çalıştık. {uygulama} üzerinden bize ulaşabilirsiniz.",
  self_servis_link: "{banka}: Talebiniz için {uygulama} üzerinden işlem yapabilirsiniz. Sizden hiçbir şifre veya kod istemeyeceğiz.",
  ikinci_basarisiz: "{banka}: Bu hafta teslimat yapılamadı. Gelecek hafta için sizi arayacağız.",
  randevu_degisti: "{banka}: Planlanan teslimatınızda değişiklik oldu. Yeni zaman için sizi arayacağız.",
};

export function renderSms(t: SmsTemplate, kb: KbConfig, vars: SmsVars = {}, operatorBody?: string): string {
  if (t === "operator") return operatorBody ?? "";
  if (PRE_VERIFICATION_TEMPLATES.includes(t) && (vars.gun || vars.aralik || vars.adres_tipi)) {
    throw new Error(`${t} şablonunda gün/aralık/adres tipi kullanılamaz`);
  }
  const map: Record<string, string> = {
    banka: kb.kurumAdi, resmi_numara: kb.arayanNumara || "resmi numaramız", uygulama: kb.uygulama.replace(/\s*\(.*\)$/, ""),
    gun: vars.gun ?? "", aralik: vars.aralik ?? "", adres_tipi: vars.adres_tipi ?? "", kurye_kodu: vars.kurye_kodu ?? "",
    kimlik_listesi: vars.kimlik_listesi ?? kb.kimlikler.join(", "),
  };
  return SMS_TEMPLATES[t].replace(/\{(\w+)\}/g, (_, k) => map[k] ?? "");
}

/** Şablon editörü uyarısı: doğrulama öncesi şablonlarda yasak değişken. */
export function templateWarnings(t: SmsTemplate, body: string): string[] {
  if (!PRE_VERIFICATION_TEMPLATES.includes(t)) return [];
  return ["{gun}", "{aralik}", "{adres_tipi}"].filter((v) => body.includes(v)).map((v) => `${v} doğrulama öncesi şablonda kullanılamaz`);
}
