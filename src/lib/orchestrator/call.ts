// Asena orkestratörü: durum makinesi + guardrail + araçlar. Kod karar verir, model konuşur (K-T7).
// Her tur: (1) anlama (kural dedektörü + Kumru JSON) → (2) deterministik karar → (3) şablon veya kısa LLM cümlesi → guardrail → TTS.
import { appName, parseKb, type KbConfig } from "../domain/kb";
import type { CharacterLibrary, Customer, Outcome } from "../domain/types";
import { addDays, isoToMs, localToMs, msToIso, parts } from "../domain/time";
import { spokenHour } from "../domain/spoken";
import { chatJson, chatText, type EngineConf } from "../engine-client/client";
import { DeliveryService, hitapOf, type SlotView } from "../service/delivery";
import { CustomerDirector, type AsenaAct } from "./customer";
import { checkOutput, maskInput, splitSentences, type OutputContext } from "./guardrails";
import { classifyConsent, classifyOffer, detect, HARD_STOPS, isYes, parseBirthDate, type Signal } from "./rules";

export type CallState =
  | "ACILIS" | "KIMLIK_SOR" | "UCUNCU_KISI" | "AYDINLATMA" | "DOGRULAMA" | "AMAC" | "SLOT_TEKLIF" | "REZERVASYON" | "TEYIT"
  | "BEKLEME_LISTESI" | "KURALLAR" | "OZET" | "GERI_ARAMA" | "INSANA_AKTAR" | "SONLANDIR";

export type CallEvent =
  | { type: "state"; from: CallState; to: CallState }
  | { type: "turn"; role: "asena" | "musteri"; text: string; speaker?: string; source?: "sablon" | "llm" | "senaryo"; masked?: boolean }
  | { type: "tool"; name: string; args: unknown; result: unknown }
  | { type: "guardrail"; rf: string; reason: string; original: string; replaced: string }
  | { type: "understanding"; rules: string[]; llm: unknown; consent?: string }
  | { type: "end"; outcome: Outcome; summary: string };

export type CallDeps = {
  svc: DeliveryService; engine: EngineConf | null; lib: CharacterLibrary;
  models: { anlama: string; konusma: string; musteri: string };
  useLlmSpeech: boolean; useLlmCustomer: boolean;
  speak: (role: "asena" | "musteri", text: string, customer: Customer) => Promise<void>;
  emit: (e: CallEvent) => void;
  stopped: () => boolean;
  maxTurns: number;
};

const ASENA_SYSTEM = (kb: KbConfig) => `Sen ${kb.kurumAdi}'nın yapay zeka asistanı Asena'sın. Sıcak, sakin, saygılı ve kısa konuşursun; "siz" dili kullanırsın.
Asla insan olduğunu söylemezsin. Kart, adres, tarih, saat, ücret, kampanya, link veya numara söylemezsin; söz vermezsin.
Sana bir amaç verilir; yalnızca o amacı tek kısa ve doğal Türkçe cümleyle söylersin. Yalnızca cümleyi yaz.`;

const UNDERSTAND_SCHEMA = (intents: string[]) => ({
  type: "object",
  properties: {
    niyet: { type: "string", enum: intents },
    onay: { type: "string", enum: ["kesin_evet", "belirsiz", "hayir"] },
    reason: { type: "string" },
  },
  required: ["niyet", "onay", "reason"],
});

const INTENTS: Partial<Record<CallState, string[]>> = {
  KIMLIK_SOR: ["kendisi", "baskasi", "yanlis_numara", "diger"],
  DOGRULAMA: ["tarih_verdi", "reddetti", "diger"],
  AMAC: ["musait", "musait_degil", "itiraz", "sikayet", "soru", "insan_talebi", "diger"],
  SLOT_TEKLIF: ["slot_kabul", "slot_ret", "kismi_musait", "soru", "itiraz", "insan_talebi", "diger"],
  TEYIT: ["onay", "ret", "belirsiz", "soru", "diger"],
  OZET: ["soru", "kapanis", "diger"],
};

export class AsenaCall {
  state: CallState = "ACILIS";
  kb: KbConfig;
  customer: Customer;
  director: CustomerDirector;
  history: { role: "asena" | "musteri"; text: string }[] = [];
  slots: SlotView[] = [];
  offerIdx = 0;
  hold: { id: string; slot: SlotView } | null = null;
  partial: { bitis: string } | null = null;
  ambiguous = 0;
  offerReasked = false;
  thirdPartyAsked = false;
  ruleExplained = new Set<string>();
  profanity = 0;
  complaintLogged = false;
  turns = 0;
  outcome: Outcome | null = null;
  slotId?: string;
  waitReason?: "kapasite_dolu" | "musteri_uygun_degil";
  verified = false;
  pendingAct: AsenaAct = { kind: "kimlik_sor" };

  constructor(public callId: string, customerId: string, public d: CallDeps) {
    this.kb = parseKb(d.svc.repo.kb());
    this.customer = d.svc.repo.customer(customerId)!;
    this.director = new CustomerDirector(this.customer, d.lib);
  }

  get hitap() { return hitapOf(this.customer); }
  private tool<T>(name: string, args: unknown, result: T): T { this.d.emit({ type: "tool", name, args, result }); return result; }
  private go(to: CallState) {
    if (to === this.state) return;
    this.d.emit({ type: "state", from: this.state, to });
    this.d.svc.decide({ callId: this.callId, customerId: this.customer.id }, { actor: "asena", tip: "durum_gecisi", ozet: `${this.state} → ${to}`, gerekce: "Durum makinesi", seviye: "bilgi" });
    this.state = to;
  }

  private outCtx(): OutputContext {
    return {
      verified: this.verified, bookingConfirmed: this.outcome === "randevu_verildi" || !!this.slotId,
      customer: { adSoyad: this.customer.adSoyad, dogumTarihi: this.customer.dogumTarihi, acikAdresler: this.customer.adresler.map((a) => a.acikAdres ?? ""), ilceler: this.customer.adresler.map((a) => a.ilce), telefon: this.customer.telefon },
      kb: { kurye_yolda_sms: this.kb.flags.kurye_yolda_sms, kurye_varista_arar: this.kb.flags.kurye_varista_arar, officialNumbers: [this.kb.arayanNumara, this.kb.musteriNumara].filter(Boolean), officialWeb: this.kb.web },
    };
  }

  /** Şablon cümle: yasal zorunlu metin, LLM'e yazdırılmaz. */
  private async say(text: string) {
    for (const s of splitSentences(text)) {
      const v = checkOutput(s, this.outCtx(), true);
      if (v.length) { this.guard(v[0].rf, v[0].reason, s, ""); continue; }
    }
    this.history.push({ role: "asena", text });
    this.d.emit({ type: "turn", role: "asena", text, source: "sablon" });
    await this.d.speak("asena", text, this.customer);
  }

  /** LLM cümlesi: yalnız amaç verilir; çıktı cümle cümle guardrail'den geçer, ihlalde şablon kullanılır. */
  private async sayFree(goal: string, fallback: string) {
    let text: string | null = null;
    if (this.d.useLlmSpeech && this.d.engine) {
      const last = this.history.slice(-4).map((h) => `${h.role === "asena" ? "Asena" : "Müşteri"}: ${h.text}`).join("\n");
      text = await chatText(this.d.engine, this.d.models.konusma, ASENA_SYSTEM(this.kb), [{ role: "user", content: `Son konuşma:\n${last}\n\nAmaç: ${goal}\nTek cümle yaz.` }], { temperature: 0.4, num_predict: 60 });
      if (text) text = splitSentences(text.replace(/^asena:\s*/i, "").replace(/["“”]/g, "")).slice(0, 2).join(" ");
    }
    if (text) {
      for (const s of splitSentences(text)) {
        const v = checkOutput(s, this.outCtx(), false);
        if (v.length) { this.guard(v[0].rf, v[0].reason, s, fallback); text = null; break; }
      }
    }
    if (!text || text.length > 220) { await this.say(fallback); return; }
    this.history.push({ role: "asena", text });
    this.d.emit({ type: "turn", role: "asena", text, source: "llm" });
    await this.d.speak("asena", text, this.customer);
  }

  private guard(rf: string, reason: string, original: string, replaced: string) {
    this.d.emit({ type: "guardrail", rf, reason, original, replaced });
    this.d.svc.decide({ callId: this.callId, customerId: this.customer.id }, { actor: "guardrail", tip: "guardrail", ozet: `${rf}: cümle engellendi${replaced ? " ve şablonla değiştirildi" : ""}`, gerekce: `${reason} · "${maskInput(original).text.slice(0, 90)}"`, ref: [rf], seviye: "kritik" });
  }

  /** Simüle müşteriden sıradaki cümle. */
  private async listen(act: AsenaAct): Promise<{ text: string; masked: string; signals: Signal[] }> {
    this.pendingAct = act;
    const line = this.director.next(act);
    let text = line.text;
    if (!line.critical && this.d.useLlmCustomer && this.d.engine && !text.startsWith("[")) {
      const r = await chatText(this.d.engine, this.d.models.musteri, this.director.systemPrompt(), [{ role: "user", content: `Söyleyeceğin cümlenin anlamı: "${text}"` }], { temperature: 0.7, num_predict: 60 });
      const clean = r?.replace(/^["“]|["”]$/g, "").split("\n")[0].trim();
      if (clean && clean.length < 200 && detect(clean).join() === detect(text).join()) text = clean; // anlam (sinyaller) korunmalı
    }
    const m = maskInput(text, { allowDate: act.kind === "dogrulama_sor" });
    let shown = m.text;
    if (act.kind === "dogrulama_sor" && parseBirthDate(text)) shown = "[doğum tarihi •••]"; // RF-04: transcript'te maskeli
    this.history.push({ role: "musteri", text: shown });
    this.d.emit({ type: "turn", role: "musteri", text: shown, speaker: line.speaker, source: line.critical || text === line.text ? "senaryo" : "llm", masked: m.masked });
    if (!text.startsWith("[")) await this.d.speak("musteri", act.kind === "dogrulama_sor" ? text : m.text, this.customer);
    this.turns++;
    const signals = detect(m.masked ? m.text + " [•••" : text);
    return { text, masked: shown, signals };
  }

  /** Kumru JSON anlama çağrısı: gerekçe (reason) karar akışına yazılır; karar kuraldadır (V-36). */
  private async understand(text: string, signals: Signal[], consent?: string) {
    const intents = INTENTS[this.state];
    let llm: { niyet: string; onay: string; reason: string } | null = null;
    if (intents && this.d.engine && this.state !== "DOGRULAMA") {
      llm = await chatJson(this.d.engine, this.d.models.anlama, `Telefon görüşmesinde müşterinin son cümlesini sınıflandır. Durum: ${this.state}. Asena'nın son sorusu: "${this.history.filter((h) => h.role === "asena").slice(-1)[0]?.text ?? ""}". Yalnız JSON döndür; reason en fazla 120 karakter.`, `Müşteri: ${text}`, UNDERSTAND_SCHEMA(intents), 6000);
    }
    this.d.emit({ type: "understanding", rules: signals, llm, consent });
    if (llm?.reason) this.d.svc.decide({ callId: this.callId, customerId: this.customer.id }, { actor: "asena", tip: "anlama", ozet: `Anlama: ${llm.niyet}${consent ? ` · onay(kural)=${consent}, onay(LLM)=${llm.onay}` : ""}`, gerekce: `${llm.reason.slice(0, 120)}${signals.length ? ` · kurallar: ${signals.join(", ")}` : ""}`, seviye: "bilgi" });
    return llm;
  }

  private async end(outcome: Outcome, summary: string) {
    if (this.hold) { await this.d.svc.release_slot(this.callId, { hold_id: this.hold.id, reason: "Görüşme bitti" }); this.hold = null; }
    this.outcome = outcome;
    this.go("SONLANDIR");
    this.tool("end_call", { outcome, summary }, this.d.svc.end_call(this.callId, { outcome, summary, slotId: this.slotId }));
    this.d.svc.postCallActions(this.callId, this.customer.id, outcome, { waitlistReason: this.waitReason });
    this.d.emit({ type: "end", outcome, summary });
  }

  // ======================================================================= ana döngü
  async run() {
    const opening = `Merhaba, iyi günler. Ben Asena, ${this.kb.kurumAdi}'nın yapay zeka asistanıyım; sizden hiçbir şifre, kod veya kart bilgisi istemeyeceğim. ${this.customer.adSoyad} ile mi görüşüyorum?`;
    await this.say(opening);
    this.go("KIMLIK_SOR");
    let act: AsenaAct = { kind: "kimlik_sor" };
    while (!this.outcome) {
      if (this.d.stopped()) { await this.end("baglanti_koptu", "Operatör görüşmeyi durdurdu"); break; }
      if (this.turns >= this.d.maxTurns) { await this.say("Sizi daha fazla tutmayayım; uygun bir zamanda tekrar arayacağız. İyi günler."); this.schedule(120, "baglanti_koptu"); await this.end("geri_arama", "Tur sınırı"); break; }
      const heard = await this.listen(act);
      const next = await this.handle(heard, act);
      if (!next) break;
      act = next;
    }
  }

  private schedule(minutes: number, source: "musteri" | "ucuncu_kisi" | "baglanti_koptu", iso?: string) {
    const when = iso ?? msToIso(isoToMs(this.d.svc.now()) + minutes * 60_000);
    return this.tool("schedule_callback", { when, source }, this.d.svc.schedule_callback(this.callId, { when, source }));
  }

  /** "dörtten sonra", "yarın öğleden sonra" → ISO (basit). */
  private parseWhen(text: string): string {
    const now = isoToMs(this.d.svc.now());
    const p = parts(now);
    const day = /yarın/.test(text) ? addDays(p.date, 1) : p.date;
    const h = text.match(/(\d{1,2})|(dört|beş|altı|üç|iki)/);
    const words: Record<string, number> = { iki: 14, üç: 15, dört: 16, beş: 17, altı: 18 };
    let hour = h?.[1] ? Number(h[1]) : h?.[2] ? words[h[2]] : p.hour + 2;
    if (hour < 9) hour += 12;
    let ms = localToMs(day, `${String(Math.min(hour, 19)).padStart(2, "0")}:00`);
    if (ms <= now) ms = now + 2 * 3600_000;
    return msToIso(ms);
  }

  // ======================================================================= karar
  private async handle(h: { text: string; masked: string; signals: Signal[] }, act: AsenaAct): Promise<AsenaAct | null> {
    const sig = new Set(h.signals);
    const svcCtx = { callId: this.callId, customerId: this.customer.id };
    const app = appName(this.kb);

    if (sig.has("baglanti_koptu")) {
      this.schedule(15, "baglanti_koptu");
      await this.end("baglanti_koptu", "Bağlantı koptu; teyit alınmadı, randevu yok (EC-90)");
      return null;
    }

    // ---------------- sert durdurma (K-25): LLM aşamaz
    const hard = HARD_STOPS.find((x) => sig.has(x));
    if (hard) {
      await this.hardStop(hard);
      return null;
    }

    // ---------------- telefonu kim açtı
    if (this.state === "KIMLIK_SOR" || this.state === "UCUNCU_KISI") {
      if (sig.has("yanlis_numara")) {
        await this.say("Anlıyorum, rahatsız ettiğim için özür dilerim. İyi günler dilerim.");
        this.d.svc.repo.setFlags(this.customer.id, (f) => { f.numara_gecersiz = { since: this.d.svc.now() }; });
        this.d.svc.plan(svcCtx, { customerId: this.customer.id, type: "insan_inceleme", dueAt: this.d.svc.addBusinessHours(isoToMs(this.d.svc.now()), 1), channel: "insan", source: "asena", reason: "Hat başkasına geçmiş", linkedEc: "EC-11" });
        await this.end("yanlis_numara", "Hat başkasına geçmiş; bilgi verilmedi (EC-11)");
        return null;
      }
      if (this.state === "UCUNCU_KISI") {
        if (sig.has("telefon_devri")) {
          this.go("KIMLIK_SOR");
          await this.say(`Teşekkür ederim. Merhaba, ben Asena, ${this.kb.kurumAdi}'nın yapay zeka asistanıyım. ${this.customer.adSoyad} ile mi görüşüyorum?`);
          return { kind: "kimlik_sor" };
        }
        const when = this.parseWhen(h.text);
        const r = this.schedule(0, "ucuncu_kisi", when);
        this.tool("add_note", {}, this.d.svc.add_note(this.callId, { category: "iletisim", visibility: "internal", text: "Hattı başka biri açtı; uygun saat alındı", linked_ec: "EC-10" }));
        await this.say(`Teşekkür ederim, ${r.ok ? `${spokenHour((r as { when: string }).when.slice(11, 16))} civarında` : "daha sonra"} tekrar denerim. İyi günler dilerim.`);
        await this.end("ucuncu_kisi", "Telefonu başkası açtı; bilgi verilmedi, geri arama planlandı (EC-10)");
        return null;
      }
      if (sig.has("ucuncu_kisi") || (!isYes(h.text) && !sig.has("aramayin"))) {
        this.go("UCUNCU_KISI");
        await this.say(`Anlıyorum, teşekkür ederim. Kendisiyle görüşmem gereken kişisel bir konu, kusura bakmayın, detay veremiyorum. ${this.customer.adSoyad.split(" ")[0]} ${this.customer.hitapEki ?? ""} hangi saatlerde ulaşabileceğimi söyleyebilir misiniz?`.replace(/\s+/g, " "));
        return { kind: "ucuncu_kisi_sor" };
      }
      if (sig.has("aramayin")) return this.doNotCall();
      // kendisi → aydınlatma + doğrulama
      this.go("AYDINLATMA");
      await this.say(`Görüşmemiz hizmet kalitesi ve güvenlik amacıyla kaydediliyor. Kişisel verilerinizin nasıl işlendiğine dair ayrıntılı bilgiyi ${app} ve ${this.kb.kvkk || "web sitemiz"} üzerinden bulabilirsiniz.`);
      this.go("DOGRULAMA");
      await this.say("Güvenliğiniz için kısa bir teyit yapmam gerekiyor. Doğum tarihinizi gün, ay ve yıl olarak söyler misiniz?");
      return { kind: "dogrulama_sor" };
    }

    // ---------------- global kesmeler
    const g = await this.globalInterrupts(sig, h);
    if (g === "ended") return null;
    if (g === "handled") return this.reask(act);

    switch (this.state) {
      case "DOGRULAMA": {
        if (sig.has("kayit_istemiyor")) {
          await this.say(`Anlıyorum. Bu görüşme güvenlik gereği kayıt altında yapılabiliyor; dilerseniz teslim zamanınızı ${app} üzerinden kendiniz de seçebilirsiniz. İyi günler dilerim.`);
          this.tool("log_event", {}, this.d.svc.log_event(this.callId, { type: "kayit_reddi", detail: "Müşteri kayıt istemedi" }));
          await this.end("musteri_kayit_istemedi", "Kayıt reddi; uygulamaya yönlendirildi (RF-11)");
          return null;
        }
        const iso = parseBirthDate(h.text);
        const r = this.tool("verify_identity", { spoken_birth_date: iso ? "•••" : null }, this.d.svc.verify_identity(this.callId, { spoken_birth_date: iso }));
        if (r.ok && r.verified) { this.verified = true; return this.purpose(); }
        if (r.ok && r.attempts_left) { await this.say("Teşekkürler. Gün, ay ve yıl şeklinde bir kez daha söyler misiniz?"); return { kind: "dogrulama_sor", retry: true }; }
        await this.say(`Şu an teyit edemediğim için devam edemiyorum. Dilerseniz ${app} üzerinden işleminizi yapabilirsiniz. İyi günler dilerim.`);
        this.d.svc.scheduleVoice(svcCtx as never, this.customer.id, "tekrar_deneme", msToIso(isoToMs(this.d.svc.now()) + 4 * 3600_000), "system", "Teyit 2 kez başarısız", "EC-63");
        this.d.svc.add_note(this.callId, { category: "iletisim", visibility: "internal", text: "Teyit 2 kez başarısız", linked_ec: "EC-63" });
        await this.end("dogrulama_basarisiz", "Doğrulama 2 kez başarısız (EC-63)");
        return null;
      }
      case "AMAC": {
        await this.understand(h.text, h.signals);
        if (sig.has("musait_degil")) {
          this.go("GERI_ARAMA");
          await this.say("Tabii, hangi saatte aramamı istersiniz?");
          return { kind: "geri_arama_saat" };
        }
        if (sig.has("iptal_istiyor")) return this.cancelRequest();
        return this.offerSlots();
      }
      case "GERI_ARAMA": {
        const when = this.parseWhen(h.text);
        const r = this.schedule(0, "musteri", when) as { ok: boolean; when?: string; warning?: string; suggestion?: string };
        const w = r.ok ? r.when! : r.suggestion!;
        if (!r.ok && r.suggestion) this.schedule(0, "musteri", r.suggestion);
        await this.say(`Not aldım, ${spokenHour(w.slice(11, 16))} civarında arayacağım.${r.warning ? " O saatte bu haftaki yer kapanmış olabilir; bunu bilmenizi isterim." : ""} İyi günler dilerim.`);
        await this.end("geri_arama", "Müşteri başka saat istedi (K-12)");
        return null;
      }
      case "SLOT_TEKLIF": {
        await this.understand(h.text, h.signals);
        const o = classifyOffer(h.text);
        const slot = this.slots[this.offerIdx];
        if (o.kind === "kabul") { this.offerReasked = false; return this.holdAndConfirm(slot); }
        if (o.kind === "kismi" && o.until) {
          const start = Number(slot.baslangic.slice(0, 2)), end = Number(slot.bitis.slice(0, 2)), until = Number(o.until.slice(0, 2));
          if ((until - start) / (end - start) >= 0.5) {
            this.partial = { bitis: o.until };
            await this.say(`Kuryeye erken gelmesini not ediyorum ama garanti edemiyorum; ${spokenHour(o.until)}'den sonra gelirse teslim olmayabilir.`);
            return this.holdAndConfirm(slot);
          }
          this.d.svc.decide(svcCtx, { actor: "asena", tip: "slot_teklif", ozet: `Kısmi müsaitlik yetersiz (${o.until}'e kadar)`, gerekce: "Aralığın yarısından azı (K-22, V-14)", ref: ["K-22", "EC-52"], seviye: "uyari" });
        }
        if (o.kind === "belirsiz" && !this.offerReasked) {
          this.offerReasked = true;
          await this.sayFree("Müşterinin söylediğine kısa ve sıcak bir karşılık ver, sorun olmadığını belirt.", "Hiç sorun değil.");
          return this.reask({ kind: "slot_teklif", slot });
        }
        this.offerReasked = false;
        return this.nextOfferOrWait();
      }
      case "TEYIT": {
        const consent = classifyConsent(h.text);
        const llm = await this.understand(h.text, h.signals, consent);
        if (sig.has("kimlik_sorunu")) return this.idProblem();
        if (consent === "kesin_evet") {
          if (llm && llm.onay === "hayir") this.d.svc.decide(svcCtx, { actor: "guardrail", tip: "guardrail", ozet: "Onay çelişkisi (kural evet, LLM hayır)", gerekce: "Güvenli taraf: tekrar soruluyor", ref: ["RF-24"], seviye: "uyari" });
          else return this.confirm();
        }
        if (consent === "hayir") {
          await this.d.svc.release_slot(this.callId, { hold_id: this.hold!.id, reason: "Müşteri teyit etmedi" }); this.hold = null;
          return this.nextOfferOrWait();
        }
        this.ambiguous++;
        if (this.ambiguous === 1) {
          await this.say("Kuryenin ikinci kez boşa gelmemesi için soruyorum: o saatte orada olabileceğinizden emin misiniz? Evet ya da hayır diyebilir misiniz?");
          return { kind: "teyit", retry: true };
        }
        await this.d.svc.release_slot(this.callId, { hold_id: this.hold!.id, reason: "İki kez belirsiz cevap (RF-24)" }); this.hold = null;
        this.d.svc.decide(svcCtx, { actor: "asena", tip: "randevu", ozet: "Randevu verilmedi: belirsiz onay", gerekce: "İkinci kez belirsiz cevap (RF-24, EC-60)", ref: ["RF-24", "EC-60"], seviye: "uyari" });
        this.schedule(180, "musteri");
        await this.say("Anlıyorum, şu an net olmadığınızı görüyorum. Sizi daha sonra tekrar arayıp birlikte netleştirelim. İyi günler dilerim.");
        await this.end("geri_arama", "Belirsiz onay; randevu verilmedi (RF-24)");
        return null;
      }
      case "OZET": {
        await this.understand(h.text, h.signals);
        if (sig.has("kurye_arar_mi")) {
          await this.say(this.kb.flags.kurye_varista_arar ? "Evet, kurye adrese varınca sizi arayacak." : "Kesin bir arama sözü veremiyorum; o aralıkta adreste olmanız yeterli. Başka bir sorunuz var mı?");
          return { kind: "ozet" };
        }
        if (h.signals.length === 0 || /teşekkür|yok|iyi günler|sağ ol/.test(h.text.toLowerCase())) {
          await this.say("Ben teşekkür ederim. İyi günler dilerim.");
          await this.end(this.slotId ? "randevu_verildi" : "bekleme_listesi", this.slotId ? `Randevu: ${this.slotId}` : "Bekleme listesi");
          return null;
        }
        await this.say("Başka bir sorunuz var mı?");
        return { kind: "ozet" };
      }
    }
    await this.say("Sizi tam anlayamadım, tekrar söyler misiniz?");
    return act;
  }

  private async reask(act: AsenaAct): Promise<AsenaAct | null> {
    if (act.kind === "slot_teklif") { await this.say(`Bu hafta için ${act.slot.sozlu} uygun görünüyor; o aralıkta adreste olabilir misiniz?`); return act; }
    if (act.kind === "dogrulama_sor") { await this.say("Doğum tarihinizi gün, ay ve yıl olarak söyler misiniz?"); return act; }
    if (act.kind === "teyit") { await this.say("Onaylıyor musunuz?"); return act; }
    if (act.kind === "amac") {
      if (this.director.hasPending("amac")) { await this.say("Anlıyorum. Devam edebilir miyiz?"); return act; }
      return this.offerSlots();
    }
    if (act.kind === "ozet") { await this.say("Başka bir sorunuz var mı?"); return act; }
    return act;
  }

  // ---------------------------------------------------------------- akış parçaları
  private async purpose(): Promise<AsenaAct> {
    this.go("AMAC");
    const ctx = this.tool("get_customer_context", {}, this.d.svc.get_customer_context(this.callId));
    const resume = ctx.ok && "notlar" in ctx && ctx.notlar.length ? " Geçen görüşmemizdeki notlarınızı da dikkate alıyorum." : "";
    await this.say(`Teşekkürler ${this.hitap}. Salı günü kartınızı teslim etmek için kuryemiz adresinize geldi ama size ulaşamadı. Bu hafta yeni bir teslim zamanı ayarlamak için arıyorum.${resume} Birkaç dakikanız var mı?`);
    return { kind: "amac" };
  }

  private async offerSlots(): Promise<AsenaAct | null> {
    this.go("SLOT_TEKLIF");
    if (this.d.engine) await this.say("Bir saniye, bölgeniz için kurye takvimine bakıyorum.");
    const r = this.tool("get_available_slots", {}, this.d.svc.get_available_slots(this.callId, { reason: "Müşteri müsait" }));
    if (!r.ok || !("slots" in r)) return this.end("insana_aktarildi", "Servis hatası").then(() => null);
    this.slots = r.slots; this.offerIdx = 0;
    if (!this.slots.length) return this.waitlist(r.dolu_sayisi > 0 ? "kapasite_dolu" : "musteri_uygun_degil");
    return this.offer();
  }

  private async offer(): Promise<AsenaAct> {
    const s = this.slots[this.offerIdx];
    const adres = s.adres_tipi === "Ev" ? "ev" : "iş yeri";
    this.d.svc.decide({ callId: this.callId, customerId: this.customer.id }, { actor: "asena", tip: "slot_teklif", ozet: `${s.slot_id} önerildi (${s.sozlu})`, gerekce: this.slots.length - this.offerIdx === 1 ? "Tek kalan seçenek" : `${this.slots.length - this.offerIdx} seçenekten ilki (kronolojik)`, ref: ["RF-12", "K-06"], seviye: "bilgi" });
    const only = this.slots.length === 1 ? "Bu hafta bölgeniz için tek uygun zaman" : this.offerIdx === 0 ? "Bu hafta için ilk uygun zaman" : "Bir diğer seçenek";
    await this.say(`${only} ${s.sozlu}, kayıtlı ${adres} adresinize. O aralıkta adreste olabilir misiniz?`);
    return { kind: "slot_teklif", slot: s };
  }

  private async nextOfferOrWait(): Promise<AsenaAct | null> {
    this.offerIdx++;
    const fresh = this.d.svc.get_available_slots(this.callId, { reason: "Güncel liste" });
    if (fresh.ok && "slots" in fresh) {
      const tried = new Set(this.slots.slice(0, this.offerIdx).map((x) => x.slot_id));
      const remaining = fresh.slots.filter((x) => !tried.has(x.slot_id));
      this.slots = [...this.slots.slice(0, this.offerIdx), ...remaining];
    }
    if (this.offerIdx < this.slots.length) return this.offer();
    return this.waitlist("musteri_uygun_degil");
  }

  private async holdAndConfirm(slot: SlotView): Promise<AsenaAct | null> {
    this.go("REZERVASYON");
    const r = await this.d.svc.hold_slot(this.callId, { slot_id: slot.slot_id, reason: "Müşteri slotu kabul etti" });
    this.tool("hold_slot", { slot_id: slot.slot_id }, r);
    if (!r.ok) {
      await this.say("Bir saniye… Bu aralık az önce doldu, kusura bakmayın.");
      this.go("SLOT_TEKLIF");
      return this.nextOfferOrWait();
    }
    this.hold = { id: (r as { hold_id: string }).hold_id, slot };
    this.go("TEYIT");
    const adres = slot.adres_tipi === "Ev" ? "ev" : "iş yeri";
    await this.say(`Teyit ediyorum: ${slot.sozlu}, kayıtlı ${adres} adresinizde, kimliğinizle sizin bizzat bulunmanız gerekiyor. Onaylıyor musunuz?`);
    return { kind: "teyit" };
  }

  private async confirm(): Promise<AsenaAct | null> {
    const r = await this.d.svc.confirm_booking(this.callId, { hold_id: this.hold!.id, customer_confirmed: true, kismi_musaitlik: this.partial ?? undefined, reason: "Kapalı teyit sorusuna kesin evet" });
    this.tool("confirm_booking", { hold_id: this.hold!.id, customer_confirmed: true }, r);
    if (!r.ok) {
      this.hold = null;
      await this.say("Kusura bakmayın, takvimde bir güncelleme oldu, tekrar bakıyorum.");
      this.go("SLOT_TEKLIF");
      return this.nextOfferOrWait();
    }
    const ok = r as { slot_id: string; sozlu_ozet: string; adres_tipi: string };
    this.slotId = ok.slot_id; this.hold = null;
    if (this.partial) this.d.svc.add_note(this.callId, { category: "kurye_notu", visibility: "courier", text: `Mümkünse ${this.partial.bitis}'den önce`, linked_ec: "EC-52" });
    this.go("KURALLAR");
    const workplace = ok.adres_tipi === "İş yeri";
    if (workplace) this.d.svc.add_note(this.callId, { category: "kurye_notu", visibility: "courier", text: this.kb.flags.kurye_varista_arar ? "İş yeri: varışta müşteriyi arayın, müşteri girişe inecek" : "İş yeri: müşteri giriş katında bekleyecek", linked_ec: "EC-42" });
    const ids = this.kb.kimlikler.slice(0, 3).join(", ");
    await this.say(`Randevunuz oluşturuldu. Kartı yalnızca size, kimliğinizi göstererek teslim edebiliyoruz; ${ids} kabul ediliyor, süresi geçerli olmalı.${workplace ? " Kurye kartı resepsiyona veya güvenliğe bırakamıyor; girişe inmeniz gerekebilir." : ""} Bilgileri ve kuryenin size söyleyeceği dört haneli doğrulama kodunu SMS ile gönderiyorum; siz kuryeye hiçbir kod söylemeyin. Yeniden teslim için herhangi bir ücret yok.`);
    this.go("OZET");
    await this.say(`Özetliyorum: kartınız ${ok.sozlu_ozet}, size kimlik kontrolüyle teslim edilecek. Başka bir sorunuz var mı?`);
    return { kind: "ozet" };
  }

  private async waitlist(reason: "kapasite_dolu" | "musteri_uygun_degil"): Promise<AsenaAct> {
    this.go("BEKLEME_LISTESI");
    this.waitReason = reason;
    this.tool("add_to_waitlist", { reason }, this.d.svc.add_to_waitlist(this.callId, { reason, why: reason === "kapasite_dolu" ? "İlçedeki tüm yerler doldu" : "Sunulan zamanlar müşteriye uymadı" }));
    const alt = this.kb.alternatifNokta ? ` Dilerseniz ${this.kb.alternatifNokta} noktasından da teslim alabilirsiniz.` : "";
    if (reason === "kapasite_dolu") await this.say(`Çok üzgünüm, bu hafta bölgenizdeki kurye zamanlarının tamamı doldu. Sizi bekleme listesine alıyorum; bu hafta bir yer boşalırsa hemen arayacağız, boşalmazsa gelecek hafta bölgenize ilk kurye çıkışından önce sizi öncelikli olarak arayacağız. Size bunu SMS ile de yazıyorum.${alt}`);
    else await this.say(`Anlıyorum. Bu hafta bölgenize yalnızca bu aralıklarda kurye çıkıyor. Sizi bekleme listesine alıyorum; bir yer boşalırsa arayacağız, boşalmazsa gelecek hafta ilk kurye çıkışından önce öncelikli olarak arayacağız.${alt}`);
    this.go("OZET");
    await this.say("Başka bir sorunuz var mı?");
    return { kind: "ozet" };
  }

  private async doNotCall(): Promise<null> {
    await this.say(this.verified ? "Numaranız kart başvurunuz sırasında bize ilettiğiniz iletişim bilgisi. Görüşmemiz kayıt altında; aydınlatma metni uygulamamızda. Talebinizi kaydettim; sizi tekrar sesli aramayacağız, teslimatla ilgili bilgiyi yalnızca uygulama veya SMS ile göndereceğiz. İyi günler dilerim."
      : "Kayıtlarımızdaki iletişim bilgisi. Talebinizi kaydettim; bu numarayı tekrar sesli aramayacağız. İyi günler dilerim.");
    this.tool("set_contact_preference", { aranmasin: true }, this.d.svc.set_contact_preference(this.callId, { aranmasin: true }));
    await this.end("aranmasin", "Müşteri aranmak istemedi (EC-72)");
    return null;
  }

  private async cancelRequest(): Promise<null> {
    await this.say(`Anlıyorum. Teslimatı durduruyorum. Kart iptali için kimlik doğrulaması gerektiğinden işlemi ${appName(this.kb)} üzerinden veya ekibimiz aracılığıyla tamamlayacağız.`);
    await this.d.svc.freeze_delivery(this.callId, { reason: "musteri_iptal_talebi" });
    this.d.svc.request_human_handoff(this.callId, { reason: "musteri_talebi" });
    await this.end("insana_aktarildi", "Müşteri kartı istemiyor (EC-33)");
    return null;
  }

  private async idProblem(): Promise<null> {
    if (this.hold) { await this.d.svc.release_slot(this.callId, { hold_id: this.hold.id, reason: "Kimlik sorunu (K-20)" }); this.hold = null; }
    await this.say(`Teslimatta kimlikteki ad soyadın kayıtla aynı olması gerekiyor. Önce soyadı değişikliğinizi ${appName(this.kb)} üzerinden bildirmeniz gerekiyor; ardından teslim zamanını birlikte ayarlayalım. Kuryenin boşa gelmemesi için şimdi randevu oluşturmuyorum.`);
    this.d.svc.add_note(this.callId, { category: "teslim_engeli", visibility: "asena", text: "Ad/soyad güncellemesi bekleniyor", linked_ec: "EC-44" });
    this.d.svc.plan({ callId: this.callId }, { customerId: this.customer.id, type: "kayit_guncelleme_takip", dueAt: msToIso(isoToMs(this.d.svc.now()) + 48 * 3600_000), channel: "ic_islem", source: "asena", reason: "Kayıt güncellemesi takibi", linkedEc: "EC-44" });
    await this.end("teslim_engeli", "Ad/soyad uyuşmazlığı; randevu verilmedi (K-20)");
    return null;
  }

  private async hardStop(kind: Signal) {
    const svcCtx = { callId: this.callId, customerId: this.customer.id };
    this.d.svc.decide(svcCtx, { actor: "asena", tip: "sert_durdurma", ozet: `Sert durdurma tetiklendi: ${kind}`, gerekce: "Kural dedektörü (LLM'den bağımsız)", ref: ["K-25"], seviye: "kritik" });
    if (this.hold) { await this.d.svc.release_slot(this.callId, { hold_id: this.hold.id, reason: "Sert durdurma" }); this.hold = null; }
    if (kind === "basvuru_itirazi") {
      await this.say("Bunu bildirdiğiniz için teşekkür ederim, çok önemli. Teslimatı hemen durduruyorum ve güvenlik ekibimiz sizinle iletişime geçecek. Bu kartla ilgili hiçbir işlem yapılmayacak.");
      await this.d.svc.freeze_delivery(this.callId, { reason: "basvuru_itirazi" });
      this.d.svc.report_security(this.callId, { type: "basvuru_itirazi", summary: "Müşteri başvuru yapmadığını söyledi" });
      this.d.svc.request_human_handoff(this.callId, { reason: "kart_talep_itirazi" });
      await this.end("kart_talep_itirazi", "Başvuru itirazı: teslimat donduruldu (EC-30, RF-27)");
    } else if (kind === "kart_aldim") {
      await this.say("Kayıtlarımızda bu kart teslim edilmemiş görünüyor. Güvenliğiniz için kartı hemen kullanıma kapatma talebi oluşturuyorum; ekibimiz sizi arayacak.");
      await this.d.svc.freeze_delivery(this.callId, { reason: "teslim_kaydi_uyusmazligi" });
      this.d.svc.report_security(this.callId, { type: "teslim_kaydi_uyusmazligi", summary: "Müşteri kartı aldığını söyledi; kayıt teslim edilmedi" });
      this.d.svc.request_human_handoff(this.callId, { reason: "risk_sinyali" });
      await this.end("insana_aktarildi", "Kartı aldım beyanı: teslimat donduruldu (EC-31, RF-27)");
    } else if (kind === "vefat" || kind === "ulasilamaz") {
      await this.say(kind === "vefat" ? "Başınız sağ olsun, çok üzüldüm. Sizi şimdi daha fazla meşgul etmeyeceğim; ekibimiz bu konuda nazik bir şekilde ilgilenecek." : "Çok geçmiş olsun. Sizi şimdi daha fazla meşgul etmeyeceğim; ekibimiz uygun bir zamanda nazik bir şekilde ilgilenecek.");
      await this.d.svc.freeze_delivery(this.callId, { reason: kind === "vefat" ? "vefat_bildirimi" : "ulasilamaz_durum" });
      this.d.svc.request_human_handoff(this.callId, { reason: "hassas_durum" });
      this.d.svc.plan(svcCtx, { customerId: this.customer.id, type: "insan_inceleme", dueAt: this.d.svc.addBusinessHours(isoToMs(this.d.svc.now()), 9), channel: "insan", source: "asena", reason: kind === "vefat" ? "Yakını vefat bildirdi" : "Yakını müşteriye şu an ulaşılamayacağını bildirdi", linkedEc: "EC-13" });
      await this.end("insana_aktarildi", "Hassas durum bildirimi; akış durduruldu (EC-13, RF-26)");
    } else if (kind === "zorlama") {
      await this.say(`Sizi şimdi daha fazla tutmayayım, uygun olduğunuzda ${appName(this.kb)} üzerinden bize ulaşabilirsiniz.`);
      await this.d.svc.freeze_delivery(this.callId, { reason: "zorlama_suphesi" });
      this.d.svc.report_security(this.callId, { type: "zorlama_suphesi", summary: "Arkadan yönlendirme izlenimi" });
      await this.end("insana_aktarildi", "Zorlama şüphesi (EC-35)");
    } else {
      await this.say("Sizi şimdi ekibimize aktarıyorum; en kısa sürede sizinle ilgilenecekler.");
      this.d.svc.request_human_handoff(this.callId, { reason: "acil" });
      await this.end("insana_aktarildi", "Tehdit veya kendine zarar ifadesi (EC-73)");
    }
  }

  private async globalInterrupts(sig: Set<Signal>, h: { text: string; masked: string }): Promise<"none" | "handled" | "ended"> {
    const app = appName(this.kb);
    const ctx = { callId: this.callId, customerId: this.customer.id };
    if (sig.has("hassas_veri")) {
      await this.say("Lütfen bu bilgiyi kimseyle, benimle de paylaşmayın; buna hiç ihtiyacım yok.");
      this.tool("log_event", { type: "hassas_veri_okuma_girisimi" }, this.d.svc.log_event(this.callId, { type: "hassas_veri_okuma_girisimi", detail: h.masked }));
      if (this.verified) this.d.svc.add_note(this.callId, { category: "guvenlik", visibility: "internal", text: "Müşteri bir kod okumaya başladı; durduruldu", linked_ec: "EC-93" });
      return "handled";
    }
    if (sig.has("insan_talebi")) {
      this.go("INSANA_AKTAR");
      const r = this.d.svc.request_human_handoff(this.callId, { reason: "musteri_talebi" });
      this.tool("request_human_handoff", { reason: "musteri_talebi" }, r);
      await this.say(`Tabii. Ekibimizden biri sizi bugün ${spokenHour(r.sla_until.slice(11, 16))}'e kadar arayacak. İyi günler dilerim.`);
      if (this.hold) { await this.d.svc.release_slot(this.callId, { hold_id: this.hold.id, reason: "İnsana aktarım" }); this.hold = null; }
      await this.end("insana_aktarildi", "Müşteri insan istedi (EC-71)");
      return "ended";
    }
    if (sig.has("aramayin")) { await this.doNotCall(); return "ended"; }
    if (sig.has("robot_mu")) { await this.say("Evet, ben bir yapay zeka asistanıyım. İsterseniz sizi ekibimizden birinin aramasını sağlayabilirim."); return "handled"; }
    if (sig.has("dogum_tarihi_tuzagi")) {
      await this.say(`Çok haklı bir dikkat; ama ben bu tür bilgileri telefonda hiçbir zaman söylemiyorum. İsterseniz şimdi kapatıp ${app} veya web sitemizdeki resmi numaradan bizi arayarak teyit edebilirsiniz.`);
      this.d.svc.log_event(this.callId, { type: "dolandiricilik_suphesi", detail: "Müşteri doğrulama tuzağı kurdu; bilgi okunmadı (RF-03)" });
      return "handled";
    }
    if (sig.has("dolandirici_mi")) { await this.say(`Çok haklı bir soru. İsterseniz şimdi kapatıp ${app} üzerinden teyit edebilirsiniz; teslim zamanınızı oradan da seçebilirsiniz.`); return "handled"; }
    if (sig.has("prompt_injection")) {
      await this.say("Bu konuda yardımcı olamam; yalnızca sizinle ilgili teslimat konusunda konuşabiliyorum.");
      this.tool("log_event", { type: "prompt_injection" }, this.d.svc.log_event(this.callId, { type: "prompt_injection", detail: "Sistem bilgisi / başka müşteri istendi" }));
      return "handled";
    }
    if (sig.has("kufur")) {
      this.profanity++;
      if (this.profanity >= 2) {
        await this.say("Sizi şimdi bırakayım; ekibimiz uygun bir zamanda size ulaşacak.");
        this.d.svc.request_human_handoff(this.callId, { reason: "musteri_talebi" });
        this.d.svc.add_note(this.callId, { category: "iletisim", visibility: "internal", text: "Görüşme hakaret nedeniyle sonlandırıldı", linked_ec: "EC-73" });
        await this.end("insana_aktarildi", "Hakaret (EC-73)");
        return "ended";
      }
      await this.say("Sizi anlıyorum ve yardımcı olmak istiyorum; ama bu şekilde devam edemeyiz.");
      return "handled";
    }
    if (!this.verified) return "none";
    if (sig.has("adres_degisikligi")) {
      await this.say(`Güvenliğiniz için telefonda yeni adres alamıyorum. Adres değişikliğini ${app} üzerinden kimlik doğrulamasıyla yapabilirsiniz.`);
      this.tool("log_event", { type: "adres_degisikligi_talebi" }, this.d.svc.log_event(this.callId, { type: "adres_degisikligi_talebi", detail: "Telefonla adres değişikliği istedi" }));
      this.d.svc.add_note(this.callId, { category: "guvenlik", visibility: "internal", text: "Telefonla adres değişikliği istedi; uygulamaya yönlendirildi", linked_ec: "EC-34" });
      this.d.svc.plan(ctx, { customerId: this.customer.id, type: "adres_degisikligi_takip", dueAt: msToIso(isoToMs(this.d.svc.now()) + 24 * 3600_000), channel: "ic_islem", source: "asena", reason: "Adres değişikliği takibi", linkedEc: "EC-34" });
      return "handled";
    }
    if (sig.has("vekalet")) {
      await this.say("Vekâletname ile teslimat yapamıyoruz; kart yalnızca size, kimliğinizi görerek teslim edilebiliyor.");
      this.d.svc.log_event(this.callId, { type: "vekalet_talebi", detail: "Vekâletle teslim istedi" });
      return "handled";
    }
    if (sig.has("baskasina_teslim")) {
      const first = !this.ruleExplained.has("ucuncu");
      this.ruleExplained.add("ucuncu");
      await this.say(first ? "Bunu sizin güvenliğiniz için yapamıyoruz: kart yalnızca size, kimliğinizi görerek teslim edilebiliyor. Size uyan bir zaman bulalım." : "Anlıyorum. Size uyan bir zaman bulmaya çalışalım.");
      this.d.svc.log_event(this.callId, { type: "ucuncu_kisiye_teslim_talebi", detail: "Başkasına teslim istedi" });
      return "handled";
    }
    if (sig.has("kesin_saat")) { await this.say("Kesin saat veremiyorum; kurye bu aralığın içinde geliyor. Rotası günün trafiğine göre planlanıyor."); return "handled"; }
    if (sig.has("tekrar")) return "handled";
    if (sig.has("kampanya")) { await this.say("Bu görüşmede yalnızca teslimatınızla ilgili yardımcı olabiliyorum; ürün ve kampanya bilgisi vermiyorum."); return "handled"; }
    if (sig.has("kapsam_disi")) {
      const r = this.d.svc.answer_from_kb(this.callId, { question: h.text });
      this.tool("answer_from_kb", { question: h.masked }, r);
      if (r.found) await this.say(String((r as { answer: string }).answer));
      else {
        await this.say(`Bunu net bilmiyorum, uydurmak istemem. ${app} üzerinden öğrenebilirsiniz; isterseniz bir uzmanımız sizi arasın.`);
        this.d.svc.add_note(this.callId, { category: "talep", visibility: "internal", text: "Kapsam dışı soru sordu (limit/aidat)", linked_ec: "EC-70" });
      }
      return "handled";
    }
    if (sig.has("sikayet") && !this.complaintLogged) {
      this.complaintLogged = true;
      const kat = /kaba/.test(h.text) ? "kurye_davranisi" : "teslim_edilemedi_itirazi";
      this.tool("log_complaint", { kategori: kat }, this.d.svc.log_complaint(this.callId, { kategori: kat, ozet: "Müşteri teslim sürecinden şikayetçi" }));
      if (/haber vermedi/.test(h.text)) await this.say("Haklısınız, önceden haber vermemiz gerekirdi. Bu kez randevuyu size yazılı da göndereceğiz ve bir gün önce hatırlatacağız.");
      else await this.sayFree("Müşterinin şikayetini suçlamadan kabul et, kısaca özür dile ve bunu inceleyeceğinizi söyle.", "Anlıyorum, sizi beklettiğimiz için gerçekten üzgünüm; bunu mutlaka inceleyeceğiz.");
      return "handled";
    }
    return "none";
  }
}
