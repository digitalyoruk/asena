// Stream PCM oynatıcı (Web Audio). Telefon filtresi opsiyonel (300–3400 Hz).
import { ttsStream, type EngineConf } from "../engine-client/client";

let ctx: AudioContext | null = null;
let current: AbortController | null = null;

export function audioCtx() {
  if (!ctx) ctx = new AudioContext({ sampleRate: 48000 });
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function stopAudio() {
  current?.abort();
  current = null;
}

/** Metni seslendirir; ilk parça gelir gelmez çalar. Bittiğinde (çalma sonu) resolve olur. Dönen değer: ilk ses (ms). */
export async function speak(conf: EngineConf, engine: string, text: string, opts: { rate?: number; pitch?: number; phone?: boolean } = {}): Promise<number | null> {
  const ac = audioCtx();
  const abort = new AbortController();
  current = abort;
  const t0 = performance.now();
  let ttfa: number | null = null;
  let playAt = ac.currentTime + 0.05;
  const pitch = opts.pitch ?? 1;
  let out: AudioNode = ac.destination;
  if (opts.phone) {
    const hp = ac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 300;
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3400;
    hp.connect(lp); lp.connect(ac.destination); out = hp;
  }
  const sources: AudioBufferSourceNode[] = [];
  abort.signal.addEventListener("abort", () => sources.forEach((s) => { try { s.stop(); } catch { /* */ } }));
  try {
    await ttsStream(conf, engine, text, opts.rate ?? 1, abort.signal, (pcm) => {
      if (ttfa === null) ttfa = performance.now() - t0;
      const buf = ac.createBuffer(1, pcm.length, 48000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = ac.createBufferSource();
      src.buffer = buf; src.playbackRate.value = pitch;
      src.connect(out);
      playAt = Math.max(playAt, ac.currentTime + 0.02);
      src.start(playAt);
      playAt += buf.duration / pitch;
      sources.push(src);
    });
  } catch (e) {
    if (abort.signal.aborted) return ttfa;
    throw e;
  }
  const wait = Math.max(0, (playAt - ac.currentTime) * 1000);
  await new Promise<void>((res) => {
    const t = setTimeout(res, wait);
    abort.signal.addEventListener("abort", () => { clearTimeout(t); res(); });
  });
  return ttfa;
}
