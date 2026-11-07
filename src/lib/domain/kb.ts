// Kurum bilgisinden (markdown) okunan alanlar. Boş alanlar için Asena uydurmaz (RF-13).
import type { KbDoc } from "./types";

export type KbConfig = {
  kurumAdi: string;
  uygulama: string;
  web: string;
  arayanNumara: string;
  musteriNumara: string;
  kvkk: string;
  flags: {
    on_bilgi_sms: boolean; randevu_teyit_sms: boolean; hatirlatma_sms: boolean; kurye_yolda_sms: boolean;
    kurye_varista_arar: boolean; kurye_adi_paylas: boolean; sesli_mesaj_birak: boolean; gelen_arama_karsilanir: boolean;
  };
  slaSaat: number;
  kimlikler: string[];
  faq: { q: string; a: string }[];
  alternatifNokta: string | null;
  warnings: string[];
};

const DEFAULT_FLAGS: KbConfig["flags"] = {
  on_bilgi_sms: true, randevu_teyit_sms: true, hatirlatma_sms: true, kurye_yolda_sms: false,
  kurye_varista_arar: false, kurye_adi_paylas: false, sesli_mesaj_birak: false, gelen_arama_karsilanir: true,
};
export const DEFAULT_IDS = ["T.C. kimlik kartı", "süresi geçerli pasaport", "yeni tip sürücü belgesi"];

function field(md: string, label: string): string {
  const re = new RegExp(`\\*\\*${label}[^*]*:\\*\\*\\s*(.+)`, "i");
  const v = md.match(re)?.[1]?.trim() ?? "";
  return /^\[.*\]$/.test(v) ? "" : v.replace(/^\[|\]$/g, "");
}

/** Kurum bilgisini yasal kurallarla basitçe karşılaştırır (arayuz-spesifikasyonu §5, EC-99). */
export function kbWarnings(md: string): string[] {
  const w: string[] = [];
  const checks: [RegExp, string][] = [
    [/şifre(nizi|si)?\s+(sor|iste|al)/i, "Şifre sorulmasını ima eden ifade (RF-01)"],
    [/\bcvv\b/i, "CVV geçiyor (RF-01)"],
    [/ücret(i)?\s*:\s*(?!ücretsiz)\d/i, "Yeniden teslim için ücret tanımı (RF-15) — Asena ücret konuşmaz"],
    [/kampanya|ek kart|limit art/i, "Kampanya/ürün ifadesi (RF-14) — Asena satış yapmaz"],
    [/başkasına teslim|komşuya|kapıcıya|vekâlet|vekalet/i, "Üçüncü kişiye/vekâletle teslim (RF-07, RF-28) — Asena kabul etmez"],
    [/adres değişikliği (telefonda )?yapılabilir/i, "Telefonda adres değişikliği (RF-08) — Asena yapmaz"],
  ];
  for (const [re, msg] of checks) if (re.test(md)) w.push(msg);
  return w;
}

export function parseKb(docs: KbDoc[]): KbConfig {
  const md = docs.filter((d) => d.active).map((d) => d.markdown).join("\n\n");
  const flags = { ...DEFAULT_FLAGS };
  let sla = 4;
  const yaml = md.match(/```ya?ml([\s\S]*?)```/)?.[1] ?? "";
  for (const line of yaml.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*:\s*([^#\n]+)/i);
    if (!m) continue;
    const [, k, raw] = m;
    const v = raw.trim();
    if (k in flags) (flags as Record<string, boolean>)[k] = v === "true";
    if (k === "insan_geri_arama_sla_saat") sla = Number(v) || 4;
  }
  const faq: { q: string; a: string }[] = [];
  for (const m of md.matchAll(/^\s*-\s*\*\*(.+?\?)\*\*\s*(.*)$/gm)) {
    const a = m[2].trim();
    if (a && !/^\[.*\]$/.test(a)) faq.push({ q: m[1].trim(), a: a.replace(/^\[|\]$/g, "") });
  }
  const alt = field(md, "Alternatif teslim noktası");
  const ids = field(md, "Teslim belgesi");
  return {
    kurumAdi: field(md, "Kurum adı") || "Asena Demo Bank",
    uygulama: field(md, "Mobil uygulama adı") || "mobil uygulamamız",
    web: field(md, "Web sitesi"),
    arayanNumara: field(md, "Arayan numara"),
    musteriNumara: field(md, "Müşterinin bizi arayabileceği numara"),
    kvkk: field(md, "KVKK aydınlatma metni adresi"),
    flags, slaSaat: sla,
    kimlikler: ids ? ids.split(/,\s*/) : DEFAULT_IDS,
    faq,
    alternatifNokta: alt && !/^yok$/i.test(alt) ? alt : null,
    warnings: kbWarnings(md),
  };
}

/** Kısa ad: "Asena Demo Bank mobil uygulaması (App Store …)" → "Asena Demo Bank mobil uygulaması" */
export function appName(kb: KbConfig) {
  return kb.uygulama.replace(/\s*\(.*\)\s*$/, "");
}
