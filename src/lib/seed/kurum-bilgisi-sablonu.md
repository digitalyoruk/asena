# Kurum Bilgisi Şablonu

> Bu şablon, arayüzdeki **Kurum Bilgisi** editörünün başlangıç içeriğidir. Kurum kendi bilgilerini buraya girer; Asena görüşmede bunları kullanır. `localStorage` → `asena:v1:kb`.
>
> ⚠️ Buraya yazılanlar yasal kuralları geçersiz kılamaz. Örneğin "telefonda adres değişikliği yapılabilir" yazılsa bile Asena yapmaz (RF-08).
>
> `[köşeli parantez]` alanlarını doldurun. Boş bırakılan alanlar için Asena bilgi uydurmaz.

---

## 1. Kurum

- **Kurum adı (Asena'nın söyleyeceği):** [Örnek: Asena Demo Bank]
- **Ticaret unvanı:** [Örnek: Asena Demo Bank A.Ş.]
- **Asena'nın tanıtım cümlesi:** "Ben Asena, [Kurum adı]'nın yapay zeka asistanıyım."

## 2. Resmi iletişim kanalları (Asena yalnızca bunları söyler, RF-16)

- **Mobil uygulama adı:** [Örnek: Asena Demo Bank, App Store / Google Play]
- **Web sitesi:** [ornek-banka.com.tr]
- **Arayan numara (bu aramaların geldiği resmi numara):** [0850 …]
- **Müşterinin bizi arayabileceği numara:** [0850 …]
- **KVKK aydınlatma metni adresi:** [ornek-banka.com.tr/kvkk]

## 3. Kart teslim politikası

- Yeniden teslim ücreti: **Ücretsiz** (değiştirmeyin; TCMB Tebliği 2020/7 kapsamında tanımlı bir ücret kalemi yoksa ücret alınamaz)
- Teslim belgesi: [Geçerli kimlik belgeleri: T.C. kimlik kartı, ehliyet, pasaport]
- Kurye geliş bildirimi: [Örnek: Kurye yola çıktığında SMS gönderilir / gönderilmez]
- Alternatif teslim noktası: [Yok / adres]
- Bu hafta teslim alamayanlar için süreç: [Örnek: Gelecek hafta ilk kurye çıkışında öncelikli aranır]

## 3b. Operasyon anahtarları (Asena bu sözleri yalnız ilgili anahtar `true` ise verir, RF-32)

```yaml
on_bilgi_sms: true            # aramadan önce "sizi X numarasından arayacağız" SMS'i
randevu_teyit_sms: true       # onayda gün/aralık/kimlik listesi/kurye kodu SMS'i
hatirlatma_sms: true          # teslimden önceki gün 18:00
kurye_yolda_sms: false        # kurye yola çıkınca SMS (operasyon gerçekten yapıyorsa true)
kurye_varista_arar: false     # kurye adrese varınca müşteriyi arar
kurye_adi_paylas: false       # teyit SMS'inde kurye adı
sesli_mesaj_birak: false      # sesli mesaja yalnız genel "sizi aradık" mesajı
ek_dil: null                  # ör. "en": Asena İngilizce akışa geçebilir
insan_geri_arama_sla_saat: 4
kabul_edilen_kimlikler: ["T.C. kimlik kartı", "Süresi geçerli pasaport", "Yeni tip sürücü belgesi", "İkamet izni (yabancılar)"]
gelen_arama_karsilanir: true  # giden numara geri arandığında Asena inbound açar
```

## 4. Sık sorulan sorular (kısa cevaplar)

- **Kartım ne zaman aktif olur?** [Örnek: Teslimden sonra mobil uygulamadan aktifleştirebilirsiniz.]
- **Kart şifremi nasıl belirlerim?** [Örnek: Mobil uygulamadan. Şifrenizi kimseyle paylaşmayın.]
- **Yıllık ücret var mı?** [Ürün bilgisine göre doldurun. Boşsa Asena "uygulamamızdan öğrenebilirsiniz" der.]
- **Limitim ne kadar?** Asena telefonda limit bilgisi vermez → "Mobil uygulamanızda görebilirsiniz."

## 5. Eskalasyon

- İnsan desteği: [Örnek: Operasyon ekibi 1 iş günü içinde geri arar]
- Şikayet kanalı: [Örnek: Uygulama > Destek > Şikayet]

## 6. Kuruma özel ek kurallar (yasal kuralları daraltabilir, genişletemez)

- [Örnek: Görüşme 3 dakikayı geçerse Asena insan desteği önerir.]
- [Örnek: Cumartesi arama yapılmaz.]
