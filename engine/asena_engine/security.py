"""Eşleştirme token'ı (~/.asena/token, 0600) ve sabit zamanlı karşılaştırma."""
from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path


def load_or_create_token(path: Path) -> str:
    if path.exists():
        token = path.read_text().strip()
        if len(token) >= 32:
            os.chmod(path, 0o600)
            return token
    return rotate_token(path)


def rotate_token(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    token = secrets.token_urlsafe(32)  # 32 bayt rastgele
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.chmod(path, 0o600)
    return token


def bearer(header: str | None) -> str | None:
    if not header or not header.lower().startswith("bearer "):
        return None
    return header[7:].strip() or None


def token_ok(given: str | None, expected: str) -> bool:
    return bool(given) and hmac.compare_digest(given.encode(), expected.encode())
