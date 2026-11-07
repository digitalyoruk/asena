"""Motor kabul kriterleri (yerel-motor.md §6) — model yüklemeden, sahte TTS ve sahte Ollama ile."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from asena_engine.app import create_app
from asena_engine.config import Settings
from asena_engine.discovery import TTSInfo
from asena_engine.llm import ThinkFilter, prepare_chat, ProxyError

TOKEN = "t" * 43
ORIGIN = "http://localhost:3100"


class FakeTTS:
    def __init__(self):
        self.cancelled = False

    def stream(self, text, **kw):
        for _ in range(5):
            yield np.zeros(4800, dtype=np.float32)

    def say(self, *a, **k):
        return None


class FakeOllama(BaseHTTPRequestHandler):
    last_body: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"models": [{"name": "alibayram/kumru:latest"}, {"name": "qwen3:4b"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        FakeOllama.last_body = json.loads(self.rfile.read(n) or b"{}")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        parts = ["<thi", "nk>gizli</th", "ink>Merhaba", " dünya"]
        for i, p in enumerate(parts):
            self.wfile.write((json.dumps({"message": {"role": "assistant", "content": p}, "done": i == len(parts) - 1}) + "\n").encode())


@pytest.fixture(scope="module")
def ollama():
    srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture()
def client(tmp_path: Path, ollama, monkeypatch):
    import asena_engine.app as appmod

    monkeypatch.setattr(appmod, "discover_tts", lambda _: {
        "ema": TTSInfo(id="ema", name="EMA Lightning", version="1.1.2", status="yukleniyor"),
        "antalia": TTSInfo(id="antalia", name="Antalia-2 Mini", version="1.0.1", status="yukleniyor"),
    })
    s = Settings()
    s.allowed_origins = [ORIGIN]
    s.ollama_host = ollama
    s.token_path = tmp_path / "token"
    s.start_ollama = False
    asgi, _ = create_app(s, tts_factory={"ema": FakeTTS, "antalia": FakeTTS}, token=TOKEN)
    with TestClient(asgi) as c:
        import time
        for _ in range(50):
            h = c.get("/health", headers={"Authorization": f"Bearer {TOKEN}"}).json()
            if all(t["status"] == "hazir" for t in h["tts"]) and h["llm"]["status"] == "hazir":
                break
            time.sleep(0.05)
        yield c


AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_health_without_token_hides_models(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "engine": "asena-engine", "version": "0.1.0", "paired": False}


def test_health_with_token_lists_models(client):
    h = client.get("/health", headers=AUTH).json()
    assert h["paired"] is True
    assert {t["id"]: t["status"] for t in h["tts"]} == {"ema": "hazir", "antalia": "hazir"}
    assert h["llm"]["selected"] == "alibayram/kumru:latest"
    assert h["llm"]["capabilities"]["alibayram/kumru:latest"]["tools"] is False


def test_unpaired_requests_get_401(client):
    assert client.post("/tts/stream", json={"engine": "ema", "text": "Merhaba."}).status_code == 401
    assert client.post("/llm/chat", json={}).json()["code"] == "UNPAIRED"
    assert client.get("/metrics", headers={"Authorization": "Bearer yanlis"}).status_code == 401


def test_disallowed_origin_rejected(client):
    r = client.get("/health", headers={"Origin": "https://kotu.example"})
    assert r.status_code == 403
    assert r.json()["code"] == "ORIGIN_NOT_ALLOWED"
    assert "access-control-allow-origin" not in r.headers


def test_allowed_origin_preflight_private_network(client):
    r = client.options("/tts/stream", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST",
                                               "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == ORIGIN
    assert r.headers["access-control-allow-private-network"] == "true"
    assert r.headers.get("access-control-allow-origin") != "*"


def test_tts_stream_pcm16(client):
    r = client.post("/tts/stream", json={"engine": "ema", "text": "Perşembe sabah dokuzla öğlen bir arası."},
                    headers={**AUTH, "Origin": ORIGIN})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/L16")
    assert len(r.content) == 5 * 4800 * 2
    assert "x-asena-spoken-text" in r.headers


def test_tts_rejects_long_text(client):
    r = client.post("/tts/stream", json={"engine": "ema", "text": "a" * 401}, headers=AUTH)
    assert r.json()["code"] == "TEXT_TOO_LONG"


def test_llm_requires_system_and_rejects_tools(client):
    base = {"model": "alibayram/kumru:latest", "messages": [{"role": "user", "content": "selam"}]}
    assert client.post("/llm/chat", json=base, headers=AUTH).json()["code"] == "SYSTEM_REQUIRED"
    tools = {**base, "messages": [{"role": "system", "content": "s"}, *base["messages"]], "tools": [{"type": "function"}]}
    r = client.post("/llm/chat", json=tools, headers=AUTH)
    assert r.status_code == 400 and r.json()["code"] == "TOOLS_UNSUPPORTED"
    other = {**base, "model": "llama3:70b", "messages": tools["messages"]}
    assert client.post("/llm/chat", json=other, headers=AUTH).json()["code"] == "MODEL_NOT_ALLOWED"


def test_llm_stream_filters_think_and_clamps_ctx(client):
    body = {"model": "alibayram/kumru:latest", "stream": True, "options": {"num_ctx": 32000},
            "messages": [{"role": "system", "content": "Sen Asena'sın."}, {"role": "user", "content": "selam"}]}
    r = client.post("/llm/chat", json=body, headers=AUTH)
    assert r.status_code == 200
    text = "".join(json.loads(l)["message"]["content"] for l in r.text.splitlines() if l.strip())
    assert text == "Merhaba dünya"
    assert "think" not in FakeOllama.last_body
    assert FakeOllama.last_body["options"]["num_ctx"] == 8192


def test_qwen_gets_no_think():
    out = prepare_chat({"model": "qwen3:4b", "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "x"}]},
                       ["qwen3:4b"], "qwen3:4b")
    assert out["think"] is False and out["messages"][-1]["content"].endswith("/no_think")


def test_think_filter_split_tags():
    f = ThinkFilter()
    out = "".join(f.feed(p) for p in ["a<th", "ink>x</thi", "nk>b<", "c"]) + f.flush()
    assert out == "ab<c"


def test_prepare_chat_bad_input():
    with pytest.raises(ProxyError):
        prepare_chat({"messages": []}, ["alibayram/kumru:latest"], "alibayram/kumru:latest")


def test_metrics(client):
    client.post("/tts/stream", json={"engine": "antalia", "text": "Merhaba."}, headers=AUTH)
    m = client.get("/metrics", headers=AUTH).json()
    assert m["tts"]["n"] >= 1
