"""FastAPI uygulaması: /health, /tts/stream, /tts/prewarm, /llm/chat, /stt, /metrics (yerel-motor.md §3)."""
from __future__ import annotations

import asyncio
import json
import logging
import statistics
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from urllib.parse import quote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__
from .config import Settings
from .discovery import LLMInfo, device_info, discover_llm, discover_stt, discover_tts, llm_capabilities
from .llm import ProxyError, ThinkFilter, prepare_chat, strip_think
from .security import bearer, load_or_create_token, token_ok
from .tts import MAX_CHARS, RATE, TTSManager

log = logging.getLogger("asena.engine")

EXPOSE = "X-Asena-Spoken-Text, X-Asena-Request-Id, X-Asena-TTFA-ms"


def err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"ok": False, "code": code, "message": message}, status_code=status)


class OriginGuard:
    """Saf ASGI CORS katmanı: allowlist, `*` yok, Private Network Access preflight'ı."""

    def __init__(self, app, allowed: list[str]):
        self.app, self.allowed = app, set(allowed)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        origin = headers.get("origin")
        if origin is not None and origin.rstrip("/") not in self.allowed:
            resp = err(403, "ORIGIN_NOT_ALLOWED", "Bu origin ASENA_ALLOWED_ORIGINS listesinde değil.")
            return await resp(scope, receive, send)
        if origin and scope["method"] == "OPTIONS" and "access-control-request-method" in headers:
            h = [
                (b"access-control-allow-origin", origin.encode()),
                (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                (b"access-control-allow-headers", b"authorization, content-type"),
                (b"access-control-max-age", b"600"),
                (b"vary", b"Origin"),
            ]
            if headers.get("access-control-request-private-network") == "true":
                h.append((b"access-control-allow-private-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": h})
            return await send({"type": "http.response.body", "body": b""})

        async def send_wrapped(message):
            if origin and message["type"] == "http.response.start":
                hs = list(message.get("headers", []))
                hs += [(b"access-control-allow-origin", origin.encode()), (b"vary", b"Origin"),
                       (b"access-control-expose-headers", EXPOSE.encode())]
                message = {**message, "headers": hs}
            await send(message)

        return await self.app(scope, receive, send_wrapped)


class Metrics:
    def __init__(self):
        self.items: deque[dict] = deque(maxlen=100)

    def add(self, **kw):
        self.items.append({"ts": time.time(), **kw})

    def summary(self) -> dict:
        def pct(vals, p):
            if not vals:
                return None
            vals = sorted(vals)
            return round(vals[min(len(vals) - 1, int(round(p / 100 * (len(vals) - 1))))], 1)

        tts = [m for m in self.items if m["kind"] == "tts"]
        llm = [m for m in self.items if m["kind"] == "llm"]
        ttfa = [m["ttfa_ms"] for m in tts if m.get("ttfa_ms") is not None]
        rtf = [m["rtf"] for m in tts if m.get("rtf")]
        ttft = [m["ttft_ms"] for m in llm if m.get("ttft_ms") is not None]
        tps = [m["tok_s"] for m in llm if m.get("tok_s")]
        return {
            "count": len(self.items),
            "tts": {"n": len(tts), "ttfa_ms_p50": pct(ttfa, 50), "ttfa_ms_p95": pct(ttfa, 95),
                    "rtf_median": round(statistics.median(rtf), 3) if rtf else None},
            "llm": {"n": len(llm), "ttft_ms_p50": pct(ttft, 50), "ttft_ms_p95": pct(ttft, 95),
                    "tok_s_median": round(statistics.median(tps), 1) if tps else None},
            "recent": list(self.items)[-20:],
        }


def create_app(settings: Settings | None = None, tts_factory: dict | None = None, token: str | None = None) -> FastAPI:
    settings = settings or Settings()
    state = {
        "token": token or load_or_create_token(settings.token_path),
        "tts": TTSManager(discover_tts(settings.hf_cache) if settings.load_tts or tts_factory else {}, settings.tts_device, tts_factory),
        "llm": LLMInfo(host=settings.ollama_host.replace("http://", ""), status="bilinmiyor"),
        "stt": {"id": "mlx-whisper", "model": "whisper-large-v3-turbo", "status": "bilinmiyor"},
        "metrics": Metrics(),
        "sem_tts": asyncio.Semaphore(20),
        "sem_llm": asyncio.Semaphore(4),
        "started": time.time(),
    }

    def rescan_llm(prewarm: bool = True):
        info = discover_llm(settings.ollama_host, settings.llm_model, settings.llm_allowed, settings.start_ollama)
        state["llm"] = info
        if prewarm and info.status == "hazir":
            try:  # ön ısıtma: modeli belleğe al (keep_alive 30m)
                httpx.post(f"{settings.ollama_host}/api/generate",
                           json={"model": info.selected, "prompt": "", "keep_alive": "30m"}, timeout=60)
            except Exception:  # noqa: BLE001
                pass
        return info

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        threading.Thread(target=state["tts"].load_all, daemon=True, name="tts-load").start()
        threading.Thread(target=rescan_llm, daemon=True, name="llm-scan").start()
        state["stt"] = discover_stt(settings.hf_cache)
        yield

    app = FastAPI(title="Asena Yerel Motor", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.asena = state
    app.state.settings = settings

    def authed(request: Request) -> bool:
        return token_ok(bearer(request.headers.get("authorization")), state["token"])

    def unpaired() -> JSONResponse:
        return err(401, "UNPAIRED", "Motoru eşleştirin: terminaldeki bağlantıyı açın.")

    # ------------------------------------------------------------------ /health
    @app.get("/health")
    async def health(request: Request):
        base = {"ok": True, "engine": "asena-engine", "version": __version__}
        if not authed(request):
            return {**base, "paired": False}
        llm: LLMInfo = state["llm"]
        return {
            **base, "paired": True,
            "tts": [i.public() for i in state["tts"].infos.values()],
            "llm": {"provider": "ollama", "host": llm.host, "status": llm.status, "models": llm.models,
                    "selected": llm.selected, "hint": llm.hint,
                    "capabilities": {m: llm_capabilities(m) for m in llm.models}},
            "stt": state["stt"],
            "device": device_info(),
            "uptime_s": round(time.time() - state["started"]),
        }

    @app.post("/health/rescan")
    async def rescan(request: Request):
        if not authed(request):
            return unpaired()
        await asyncio.to_thread(rescan_llm, False)
        state["stt"] = discover_stt(settings.hf_cache)
        return await health(request)

    # ------------------------------------------------------------------ TTS
    @app.post("/tts/stream")
    async def tts_stream(request: Request):
        if not authed(request):
            return unpaired()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return err(400, "BAD_REQUEST", "JSON gövde bekleniyor")
        engine = body.get("engine", "ema")
        text = str(body.get("text", "")).strip()
        rate = float(body.get("rate", 1.0) or 1.0)
        seed = int(body.get("seed", 0) or 0)
        tts: TTSManager = state["tts"]
        if engine not in tts.infos:
            return err(400, "BAD_ENGINE", "engine: ema | antalia")
        if not tts.ready(engine):
            name = tts.infos[engine].name
            return err(503, "TTS_NOT_READY", f"{name} hazır değil ({tts.infos[engine].status}): `uv sync` çalıştırın.")
        if not text:
            return err(400, "EMPTY_TEXT", "text boş")
        if len(text) > MAX_CHARS:
            return err(400, "TEXT_TOO_LONG", f"En fazla {MAX_CHARS} karakter; metni cümlelere bölün.")
        if not (0.5 <= rate <= 2.0):
            return err(400, "BAD_RATE", "rate 0.5–2.0")
        sem: asyncio.Semaphore = state["sem_tts"]
        if sem.locked():
            return err(429, "RATE_LIMITED", "Eşzamanlı TTS sınırı (20)")
        await sem.acquire()

        rid = uuid.uuid4().hex[:12]
        cancel = threading.Event()
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()

        def producer():
            try:
                for b in tts.stream(engine, text, rate, seed, cancel):
                    loop.call_soon_threadsafe(queue.put_nowait, b)
                    if cancel.is_set():
                        break
            except Exception as e:  # noqa: BLE001
                log.exception("TTS hata")
                loop.call_soon_threadsafe(queue.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        threading.Thread(target=producer, daemon=True, name=f"tts-{rid}").start()

        async def gen():
            ttfa = None
            nbytes = 0
            try:
                while True:
                    item = await queue.get()
                    if item is None or isinstance(item, Exception):
                        break
                    if ttfa is None:
                        ttfa = (time.perf_counter() - t0) * 1000
                    nbytes += len(item)
                    yield item
            finally:
                cancel.set()
                sem.release()
                total = (time.perf_counter() - t0) * 1000
                audio_s = nbytes / 2 / RATE
                state["metrics"].add(kind="tts", engine=engine, chars=len(text), ttfa_ms=round(ttfa or 0, 1),
                                     total_ms=round(total, 1), audio_s=round(audio_s, 2),
                                     rtf=round(total / 1000 / audio_s, 3) if audio_s else None,
                                     cancelled=audio_s == 0 or total < 0)
                if settings.log_text:
                    log.info("tts %s %r", engine, text)
                else:
                    log.info("tts %s chars=%d audio=%.2fs total=%.0fms", engine, len(text), audio_s, total)

        spoken = text
        try:
            from antalia_mini.api import model_text

            spoken = model_text(text)
        except Exception:  # noqa: BLE001
            pass
        headers = {"X-Asena-Request-Id": rid, "X-Asena-Spoken-Text": quote(spoken[:500]), "Cache-Control": "no-store"}
        return StreamingResponse(gen(), media_type=f"audio/L16; rate={RATE}; channels=1", headers=headers)

    @app.post("/tts/prewarm")
    async def tts_prewarm(request: Request):
        if not authed(request):
            return unpaired()
        body = await request.json()
        items = (body or {}).get("items", [])[:60]
        tts: TTSManager = state["tts"]
        done = 0
        for it in items:
            eng, text = it.get("engine", "ema"), str(it.get("text", "")).strip()
            if tts.ready(eng) and text and len(text) <= MAX_CHARS:
                await asyncio.to_thread(tts.synthesize, eng, text, float(it.get("rate", 1.0) or 1.0), int(it.get("seed", 0) or 0))
                done += 1
        return {"ok": True, "cached": done, "cache_size": len(tts.cache)}

    # ------------------------------------------------------------------ LLM
    @app.post("/llm/chat")
    async def llm_chat(request: Request):
        if not authed(request):
            return unpaired()
        try:
            body = prepare_chat(await request.json(), settings.llm_allowed, settings.llm_model)
        except ProxyError as e:
            return err(e.status, e.code, e.message)
        except Exception:  # noqa: BLE001
            return err(400, "BAD_REQUEST", "JSON gövde bekleniyor")
        sem: asyncio.Semaphore = state["sem_llm"]
        if sem.locked():
            return err(429, "RATE_LIMITED", "Eşzamanlı LLM sınırı (4)")
        await sem.acquire()
        url = f"{settings.ollama_host}/api/chat"
        t0 = time.perf_counter()
        client = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=3))

        def map_error(status: int, text: str) -> JSONResponse:
            if status == 404 or "not found" in text.lower():
                return err(503, "LLM_MODEL_MISSING", f"ollama pull {body['model'].removesuffix(':latest')}")
            return err(502, "OLLAMA_ERROR", text[:300])

        if not body.get("stream"):
            try:
                r = await client.post(url, json=body)
                if r.status_code != 200:
                    return map_error(r.status_code, r.text)
                data = r.json()
                msg = data.get("message") or {}
                msg["content"] = strip_think(msg.get("content", ""))
                data["message"] = msg
                state["metrics"].add(kind="llm", model=body["model"], ttft_ms=None,
                                     total_ms=round((time.perf_counter() - t0) * 1000, 1),
                                     tokens=data.get("eval_count"),
                                     tok_s=round(data["eval_count"] / (data["eval_duration"] / 1e9), 1) if data.get("eval_duration") else None)
                return data
            except httpx.ConnectError:
                return err(503, "OLLAMA_DOWN", "Ollama uygulamasını açın.")
            finally:
                await client.aclose()
                sem.release()

        try:
            req = client.build_request("POST", url, json=body)
            resp = await client.send(req, stream=True)
        except httpx.ConnectError:
            await client.aclose()
            sem.release()
            return err(503, "OLLAMA_DOWN", "Ollama uygulamasını açın.")
        if resp.status_code != 200:
            text = (await resp.aread()).decode(errors="ignore")
            await resp.aclose()
            await client.aclose()
            sem.release()
            return map_error(resp.status_code, text)

        async def gen():
            filt = ThinkFilter()
            ttft = None
            last = {}
            try:
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    msg = obj.get("message") or {}
                    if "content" in msg:
                        msg["content"] = filt.feed(msg["content"])
                        if obj.get("done"):
                            msg["content"] += filt.flush()
                        if msg["content"] and ttft is None:
                            ttft = (time.perf_counter() - t0) * 1000
                    msg.pop("thinking", None)
                    obj["message"] = msg
                    last = obj
                    yield (json.dumps(obj, ensure_ascii=False) + "\n").encode()
            finally:
                await resp.aclose()
                await client.aclose()
                sem.release()
                ev, dur = last.get("eval_count"), last.get("eval_duration")
                state["metrics"].add(kind="llm", model=body["model"], ttft_ms=round(ttft, 1) if ttft else None,
                                     total_ms=round((time.perf_counter() - t0) * 1000, 1), tokens=ev,
                                     tok_s=round(ev / (dur / 1e9), 1) if ev and dur else None)

        return StreamingResponse(gen(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})

    # ------------------------------------------------------------------ STT (opsiyonel)
    @app.post("/stt")
    async def stt(request: Request):
        if not authed(request):
            return unpaired()
        if state["stt"].get("status") != "hazir":
            return err(503, "STT_NOT_READY", "mlx-whisper bulunamadı: `uv sync --extra stt` çalıştırın.")
        import os
        import tempfile

        data = await request.body()
        if not data or len(data) > 20_000_000:
            return err(400, "BAD_AUDIO", "Ses gövdesi boş veya çok büyük")
        suffix = ".webm" if "webm" in request.headers.get("content-type", "") else ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(data)
            path = f.name
        t0 = time.perf_counter()
        try:
            import mlx_whisper

            out = await asyncio.to_thread(mlx_whisper.transcribe, path, path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language="tr")
        finally:
            os.unlink(path)
        return {"text": str(out.get("text", "")).strip(), "language": "tr", "duration_ms": round((time.perf_counter() - t0) * 1000)}

    @app.get("/metrics")
    async def metrics(request: Request):
        if not authed(request):
            return unpaired()
        return state["metrics"].summary()

    return OriginGuard(app, settings.allowed_origins), app
