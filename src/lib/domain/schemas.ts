// localStorage'dan okunan kayıtlar Zod ile doğrulanır; bozuk kayıt görüşmeye alınmaz (dinamik-veri.md §1.4).
import { z } from "zod";

const hm = z.string().regex(/^\d{2}:\d{2}$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AddressSchema = z.object({
  id: z.string().min(1),
  tip: z.enum(["Ev", "İş yeri"]),
  ilce: z.string().min(2),
  acikAdres: z.string().optional(),
  dogrulanmis: z.boolean(),
});

export const CharacterSchema = z.object({
  arketipId: z.string(), magduriyetId: z.string(), musaitlikProfilId: z.string(), sapmaIds: z.array(z.string()).max(4),
  ekNot: z.string().optional(), seed: z.string(), elleDuzenlendi: z.boolean(),
});

export const CustomerSchema = z.object({
  id: z.string().min(1),
  adSoyad: z.string().min(3),
  hitapEki: z.enum(["Hanım", "Bey"]).nullable().optional(),
  telefon: z.string().regex(/^\+90\d{10}$/, "Telefon +90 ile 10 hane olmalı"),
  dogumTarihi: ymd,
  adresler: z.array(AddressSchema).min(1),
  teslimAdresId: z.string(),
  kart: z.object({ konum: z.enum(["basimda", "depoda", "kuryede", "teslim_edildi", "bloke", "imha"]), basarisizTeslim: z.number().int().min(0), sonDeneme: z.string().optional() }),
  durum: z.string(),
  karakter: CharacterSchema.optional(),
  etiketler: z.array(z.string()).optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).refine((c) => c.adresler.some((a) => a.id === c.teslimAdresId), { message: "Teslim adresi adres listesinde yok" });

export const SlotSchema = z.object({
  id: z.string().min(1), kurye: z.string().optional(), ilce: z.string().min(2), tarih: ymd,
  baslangic: hm, bitis: hm, kapasite: z.number().int().min(1), aktif: z.boolean(), not: z.string().optional(),
}).refine((s) => s.baslangic < s.bitis, { message: "Başlangıç bitişten önce olmalı" });

export function trKey(s: string) {
  return s.toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").trim();
}
/** İlçe eşleşmesi: büyük-küçük ve Türkçe karakter duyarsız. */
export function sameDistrict(a: string, b: string) {
  return trKey(a) === trKey(b);
}
