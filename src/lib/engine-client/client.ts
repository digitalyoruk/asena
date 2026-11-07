// Yerel motor istemcisi (127.0.0.1:8787, IP literal; K-T3).
export type EngineConf = { url: string; token: string | null };

export type Health = {
  ok: boolean; paired: boolean; version: string;
  tts?: { id: string; name: string; version: string; status: string }[];
  llm?: { status: string; models: string[]; selected: string | null; hint?: string | null };
  stt?: { status: string };
};

function headers(c: EngineConf) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (c.token) h.Authorization = `Bearer ${c.token}`;
  return h;
}

export async function health(c: EngineConf): Promise<Health | { error: string }> {
  try {
    const r = await fetch(`${c.url}/health`, { headers: c.token ? { Authorization: `Bearer ${c.token}` } : {} });
    if (r.status === 403) return { error: "ORIGIN_NOT_ALLOWED" };
    return await r.json();
  } catch {
    return { error: "ENGINE_UNREACHABLE" };
  }
}

export async function chatJson<T>(c: EngineConf, model: string, system: string, user: string, schema: object, timeoutMs = 8000): Promise<T | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${c.url}/llm/chat`, {
      method: "POST", headers: headers(c), signal: ac.signal,
      body: JSON.stringify({ model, stream: false, format: schema, options: { temperature: 0, top_p: 1, repeat_penalty: 1, num_predict: 120 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return JSON.parse(d.message?.content ?? "null") as T;
  } catch { return null; } finally { clearTimeout(t); }
}

export async function chatText(c: EngineConf, model: string, system: string, messages: { role: "user" | "assistant"; content: string }[], opts: { temperature: number; num_predict: number }, timeoutMs = 9000): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${c.url}/llm/chat`, {
      method: "POST", headers: headers(c), signal: ac.signal,
      body: JSON.stringify({ model, stream: false, options: { ...opts, top_p: 0.9, repeat_penalty: 1.1 }, messages: [{ role: "system", content: system }, ...messages] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return String(d.message?.content ?? "").trim() || null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** /tts/stream → PCM16 48 kHz parçaları. */
export async function ttsStream(c: EngineConf, engine: string, text: string, rate: number, signal: AbortSignal, onChunk: (pcm: Int16Array) => void) {
  const r = await fetch(`${c.url}/tts/stream`, { method: "POST", headers: headers(c), body: JSON.stringify({ engine, text, rate, seed: 0 }), signal });
  if (!r.ok || !r.body) throw new Error(`TTS ${r.status}`);
  const reader = r.body.getReader();
  let rest = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = new Uint8Array(rest.length + value.length);
    buf.set(rest); buf.set(value, rest.length);
    const even = buf.length - (buf.length % 2);
    rest = buf.slice(even);
    if (even) onChunk(new Int16Array(buf.slice(0, even).buffer));
  }
}
