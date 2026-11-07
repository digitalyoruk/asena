"""TTS yükleme ve stream. Ağırlıklar HF önbelleğinden, internete çıkmadan (HF_HUB_OFFLINE=1) yüklenir."""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from typing import Callable, Iterator

import numpy as np

from .discovery import TTSInfo

log = logging.getLogger("asena.tts")
RATE = 48000
MAX_CHARS = 400


def pcm16(chunk: np.ndarray) -> bytes:
    a = np.asarray(chunk, dtype=np.float32).reshape(-1)
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class TTSManager:
    """İki modeli bir kez yükler (warm-up ile); stream ve önbellek sunar."""

    def __init__(self, infos: dict[str, TTSInfo], device: str = "cpu", factory: dict[str, Callable] | None = None):
        self.infos = infos
        self.device = device
        self.models: dict[str, object] = {}
        self.cache: OrderedDict[tuple, bytes] = OrderedDict()
        self.cache_limit = 256
        self._factory = factory or {"ema": self._load_ema, "antalia": self._load_antalia}
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- yükleme
    def _load_ema(self):
        from ema_lightning import EMA

        m = EMA(device=self.device)
        m.say("Merhaba.", seed=0)  # warm-up
        return m

    def _load_antalia(self):
        from antalia_mini import Antalia

        return Antalia(device=self.device, sample_rate=RATE, warmup=True)

    def load_all(self) -> None:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        for tid, info in self.infos.items():
            if info.status != "yukleniyor":
                continue
            t0 = time.perf_counter()
            try:
                self.models[tid] = self._factory[tid]()
                info.status = "hazir"
                log.info("TTS %s hazır (%.1f sn)", tid, time.perf_counter() - t0)
            except Exception as e:  # noqa: BLE001
                info.status = "yukleme_hatasi"
                info.error = type(e).__name__ + ": " + str(e)[:200]
                log.exception("TTS %s yüklenemedi", tid)

    def ready(self, engine: str) -> bool:
        return engine in self.models and self.infos.get(engine) is not None and self.infos[engine].status == "hazir"

    # ---------------------------------------------------------------- sentez
    def stream(self, engine: str, text: str, rate: float = 1.0, seed: int = 0, cancel: threading.Event | None = None) -> Iterator[bytes]:
        """PCM16 mono 48 kHz parçaları. cancel set edilirse sentez durur (barge-in)."""
        key = (engine, text, round(rate, 3), seed)
        cached = self.cache.get(key)
        if cached is not None:
            self.cache.move_to_end(key)
            step = RATE * 2  # ~1 sn'lik parçalar
            for i in range(0, len(cached), step):
                if cancel is not None and cancel.is_set():
                    return
                yield cached[i:i + step]
            return
        model = self.models[engine]
        if engine == "ema":
            it = model.stream(text, speed=float(rate), seed=int(seed), sample_rate=RATE)
        else:
            it = model.stream(text, seed=int(seed), speed=0.95 * float(rate))
        try:
            for chunk in it:
                if cancel is not None and cancel.is_set():
                    break
                yield pcm16(chunk)
        finally:
            close = getattr(it, "close", None)
            if close:
                close()  # paket stream'i bırakılınca kalan işi düşürür

    def synthesize(self, engine: str, text: str, rate: float = 1.0, seed: int = 0) -> bytes:
        key = (engine, text, round(rate, 3), seed)
        if key in self.cache:
            return self.cache[key]
        data = b"".join(self.stream(engine, text, rate, seed))
        with self._lock:
            self.cache[key] = data
            while len(self.cache) > self.cache_limit:
                self.cache.popitem(last=False)
        return data
