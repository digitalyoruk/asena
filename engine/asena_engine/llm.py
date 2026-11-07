"""Ollama /api/chat proxy kuralları ve akış içi <think> süzgeci (yerel-motor.md §3)."""
from __future__ import annotations

import re


class ProxyError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def prepare_chat(body: dict, allowed: list[str], default_model: str) -> dict:
    """İsteği doğrular ve motorun zorladığı alanları uygular. Gövdeyi değiştirip döndürür."""
    if not isinstance(body, dict):
        raise ProxyError(400, "BAD_REQUEST", "JSON gövde bekleniyor")
    model = body.get("model") or default_model
    if model not in allowed:
        raise ProxyError(403, "MODEL_NOT_ALLOWED", f"İzinli modeller: {', '.join(allowed)}")
    is_qwen = model.startswith("qwen3")
    if body.get("tools") and not is_qwen:
        raise ProxyError(400, "TOOLS_UNSUPPORTED", "Kumru tool calling desteklemez; anlama çağrısında `format` (JSON şeması) kullanın.")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ProxyError(400, "BAD_REQUEST", "messages zorunlu")
    if not any(isinstance(m, dict) and m.get("role") == "system" and str(m.get("content", "")).strip() for m in messages):
        raise ProxyError(400, "SYSTEM_REQUIRED", "Sistem mesajı zorunlu (modelin varsayılan kimliği devreye girmesin).")
    out = {k: v for k, v in body.items() if k in {"messages", "format", "options", "stream", "keep_alive"}}
    out["model"] = model
    opts = dict(out.get("options") or {})
    opts["num_ctx"] = min(int(opts.get("num_ctx", 8192)), 8192)
    out["options"] = opts
    out.setdefault("keep_alive", "30m")
    out.setdefault("stream", True)
    if is_qwen:
        out["think"] = False
        msgs = [dict(m) for m in messages]
        for m in reversed(msgs):
            if m.get("role") == "user":
                if "/no_think" not in str(m.get("content", "")):
                    m["content"] = f"{m.get('content', '')} /no_think"
                break
        out["messages"] = msgs
    return out


class ThinkFilter:
    """Parça parça gelen metinden <think>…</think> bloklarını süzer (etiket parçalara bölünse bile)."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.inside = False
        self.buf = ""

    def feed(self, text: str) -> str:
        self.buf += text
        out = []
        while self.buf:
            tag = self.CLOSE if self.inside else self.OPEN
            idx = self.buf.find(tag)
            if idx >= 0:
                if not self.inside:
                    out.append(self.buf[:idx])
                self.buf = self.buf[idx + len(tag):]
                self.inside = not self.inside
                continue
            # etiketin başı olabilecek kuyruğu tut
            keep = 0
            for k in range(min(len(tag) - 1, len(self.buf)), 0, -1):
                if tag.startswith(self.buf[-k:]):
                    keep = k
                    break
            emit, self.buf = self.buf[: len(self.buf) - keep], self.buf[len(self.buf) - keep:]
            if not self.inside:
                out.append(emit)
            break
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def strip_think(text: str) -> str:
    return re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.S)
