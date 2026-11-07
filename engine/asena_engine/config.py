"""Ortam değişkenlerinden okunan ayarlar. Bağlanma adresi sabittir: 127.0.0.1 (değiştirilemez)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

HOST = "127.0.0.1"  # K-T4: yalnız loopback; --host parametresi yok

DEFAULT_ORIGINS = "http://localhost:3000,http://localhost:3100,http://127.0.0.1:3100"
DEFAULT_LLM = "alibayram/kumru:latest"
DEFAULT_ALLOWED = "alibayram/kumru:latest,qwen3:4b"


def _csv(value: str) -> list[str]:
    return [v.strip().rstrip("/") for v in value.split(",") if v.strip()]


@dataclass
class Settings:
    port: int = field(default_factory=lambda: int(os.environ.get("ASENA_PORT", "8787")))
    allowed_origins: list[str] = field(default_factory=lambda: _csv(os.environ.get("ASENA_ALLOWED_ORIGINS", DEFAULT_ORIGINS)))
    ollama_host: str = field(default_factory=lambda: os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/"))
    llm_model: str = field(default_factory=lambda: os.environ.get("ASENA_LLM_MODEL", DEFAULT_LLM))
    llm_allowed: list[str] = field(default_factory=lambda: _csv(os.environ.get("ASENA_LLM_ALLOWED", DEFAULT_ALLOWED)))
    hf_cache: Path = field(default_factory=lambda: Path(os.environ.get("ASENA_HF_CACHE", Path.home() / ".cache" / "huggingface" / "hub")).expanduser())
    token_path: Path = field(default_factory=lambda: Path(os.environ.get("ASENA_TOKEN_PATH", Path.home() / ".asena" / "token")).expanduser())
    log_text: bool = field(default_factory=lambda: os.environ.get("ASENA_LOG_TEXT") == "1")
    tts_device: str = field(default_factory=lambda: os.environ.get("ASENA_TTS_DEVICE", "cpu"))
    load_tts: bool = field(default_factory=lambda: os.environ.get("ASENA_SKIP_TTS") != "1")
    start_ollama: bool = field(default_factory=lambda: os.environ.get("ASENA_NO_OLLAMA_START") != "1")

    def __post_init__(self) -> None:
        if not self.ollama_host.startswith("http"):
            self.ollama_host = "http://" + self.ollama_host
        if self.llm_model not in self.llm_allowed:
            self.llm_allowed.insert(0, self.llm_model)
