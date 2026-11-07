"""Model keşfi (yerel-motor.md §2): Python paketleri + HF önbelleği + Ollama /api/tags + mlx-whisper."""
from __future__ import annotations

import importlib.metadata as md
import importlib.util
import platform
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

TTS_SPECS = {
    "ema": {"name": "EMA Lightning", "package": "ema-lightning", "module": "ema_lightning", "repo": "canberkkkkkk/ema-lightning", "expected": "1.1.2"},
    "antalia": {"name": "Antalia-2 Mini", "package": "antalia-mini", "module": "antalia_mini", "repo": "cloud0day3/antalia-mini", "expected": "1.0.1"},
}
STT_REPO = "mlx-community/whisper-large-v3-turbo"


@dataclass
class TTSInfo:
    id: str
    name: str
    version: str | None = None
    status: str = "paket_yok"  # hazir | yukleniyor | paket_yok | agirlik_yok | yukleme_hatasi
    sample_rate: int = 48000
    voices: int = 1
    snapshot: str | None = None
    error: str | None = None

    def public(self) -> dict:
        d = {"id": self.id, "name": self.name, "version": self.version, "status": self.status,
             "sample_rate": self.sample_rate, "voices": self.voices}
        if self.error:
            d["error"] = self.error
        return d


@dataclass
class LLMInfo:
    host: str
    status: str = "bilinmiyor"  # hazir | model_yok | ollama_kapali
    models: list[str] = field(default_factory=list)
    selected: str | None = None
    hint: str | None = None


def package_version(package: str) -> str | None:
    try:
        return md.version(package)
    except md.PackageNotFoundError:
        return None


def hf_cached_repos(cache_dir: Path) -> dict[str, str]:
    """repo_id → en yeni snapshot yolu. Ağa çıkmaz."""
    found: dict[str, str] = {}
    try:
        from huggingface_hub import scan_cache_dir

        info = scan_cache_dir(cache_dir)
        for repo in info.repos:
            if repo.repo_type != "model" or not repo.revisions:
                continue
            rev = max(repo.revisions, key=lambda r: r.last_modified)
            found[repo.repo_id] = str(rev.snapshot_path)
    except Exception:
        # scan_cache_dir yoksa ya da önbellek bozuksa klasör adlarına bak
        if cache_dir.exists():
            for d in cache_dir.glob("models--*"):
                snaps = sorted((d / "snapshots").glob("*"), key=lambda p: p.stat().st_mtime)
                if snaps:
                    found[d.name[len("models--"):].replace("--", "/")] = str(snaps[-1])
    return found


def discover_tts(cache_dir: Path) -> dict[str, TTSInfo]:
    repos = hf_cached_repos(cache_dir)
    out: dict[str, TTSInfo] = {}
    for tid, spec in TTS_SPECS.items():
        info = TTSInfo(id=tid, name=spec["name"])
        info.version = package_version(spec["package"])
        if info.version is None or importlib.util.find_spec(spec["module"]) is None:
            info.status = "paket_yok"
        elif spec["repo"] not in repos:
            info.status = "agirlik_yok"
        else:
            info.snapshot = repos[spec["repo"]]
            info.status = "yukleniyor"
        out[tid] = info
    return out


def ollama_tags(host: str, timeout: float = 2.0) -> list[str] | None:
    try:
        r = httpx.get(f"{host}/api/tags", timeout=timeout)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return None


def ensure_ollama(host: str, start: bool) -> list[str] | None:
    tags = ollama_tags(host)
    if tags is not None or not start:
        return tags
    exe = shutil.which("ollama")
    if not exe:
        return None
    # Ollama'yı yalnız 127.0.0.1'de başlat; OLLAMA_ORIGINS'e dokunma (K-T4/4)
    subprocess.Popen([exe, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                     env={**__import__("os").environ, "OLLAMA_HOST": host.replace("http://", "")})
    for _ in range(20):
        time.sleep(0.5)
        tags = ollama_tags(host)
        if tags is not None:
            return tags
    return None


def discover_llm(host: str, selected: str, allowed: list[str], start: bool) -> LLMInfo:
    info = LLMInfo(host=host.replace("http://", ""))
    tags = ensure_ollama(host, start)
    if tags is None:
        info.status = "ollama_kapali"
        info.hint = "Ollama uygulamasını açın."
        return info
    info.models = [m for m in allowed if m in tags or m.removesuffix(":latest") in tags]
    if selected in info.models:
        info.selected = selected
        info.status = "hazir"
    else:
        info.status = "model_yok"
        info.hint = f"ollama pull {selected.removesuffix(':latest')}"
    return info


def llm_capabilities(model: str) -> dict:
    if model.startswith("qwen3"):
        return {"tools": True, "thinking": True, "json_format": True, "num_ctx": 8192}
    return {"tools": False, "thinking": False, "json_format": True, "num_ctx": 8192}


def discover_stt(cache_dir: Path) -> dict:
    has_pkg = importlib.util.find_spec("mlx_whisper") is not None
    has_weights = STT_REPO in hf_cached_repos(cache_dir)
    status = "hazir" if has_pkg and has_weights else ("paket_yok" if not has_pkg else "agirlik_yok")
    return {"id": "mlx-whisper", "model": "whisper-large-v3-turbo", "status": status}


def device_info() -> dict:
    return {"platform": platform.system().lower(), "arch": platform.machine()}
