"""`asena-engine` komutu: serve (varsayılan) | rotate-token | pair | install-agent | uninstall-agent."""
from __future__ import annotations

import argparse
import logging
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # ağırlıklar yalnız önbellekten (K-T2)
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from .config import HOST, Settings  # noqa: E402
from .security import load_or_create_token, rotate_token  # noqa: E402

AGENT = "dev.asena.engine"


def pair_links(settings: Settings, token: str) -> list[str]:
    return [f"{o}/eslestir#t={token}" for o in settings.allowed_origins]


def print_banner(settings: Settings, token: str) -> None:
    print("\n  Asena Yerel Motor  ·  http://%s:%d" % (HOST, settings.port))
    print("  İzinli origin'ler: " + ", ".join(settings.allowed_origins))
    print("  Eşleştirme bağlantıları (birini tarayıcıda açın):")
    for link in pair_links(settings, token):
        print("    " + link)
    print(flush=True)


def serve(settings: Settings) -> None:
    import uvicorn

    from .app import create_app

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    hf_cache = str(settings.hf_cache)
    os.environ.setdefault("HF_HUB_CACHE", hf_cache)
    token = load_or_create_token(settings.token_path)
    asgi, _ = create_app(settings, token=token)
    print_banner(settings, token)
    uvicorn.run(asgi, host=HOST, port=settings.port, log_level="warning")


def install_agent(settings: Settings) -> None:
    exe = shutil.which("asena-engine") or sys.argv[0]
    plist = Path.home() / "Library" / "LaunchAgents" / f"{AGENT}.plist"
    plist.parent.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k.startswith(("ASENA_", "OLLAMA_"))}
    env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
    data = {"Label": AGENT, "ProgramArguments": [exe, "serve"], "RunAtLoad": True, "KeepAlive": True,
            "EnvironmentVariables": env, "StandardOutPath": str(Path.home() / ".asena" / "engine.log"),
            "StandardErrorPath": str(Path.home() / ".asena" / "engine.log")}
    plist.write_bytes(plistlib.dumps(data))
    subprocess.run(["launchctl", "unload", str(plist)], capture_output=True)
    subprocess.run(["launchctl", "load", str(plist)], check=False)
    print(f"LaunchAgent kuruldu: {plist}")


def uninstall_agent() -> None:
    plist = Path.home() / "Library" / "LaunchAgents" / f"{AGENT}.plist"
    if plist.exists():
        subprocess.run(["launchctl", "unload", str(plist)], capture_output=True)
        plist.unlink()
    print("LaunchAgent kaldırıldı")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="asena-engine", description="Asena Yerel Motor (yalnız 127.0.0.1)")
    p.add_argument("command", nargs="?", default="serve",
                   choices=["serve", "rotate-token", "pair", "install-agent", "uninstall-agent"])
    p.add_argument("--port", type=int, default=None)
    args = p.parse_args(argv)
    settings = Settings()
    if args.port:
        settings.port = args.port
    if args.command == "serve":
        serve(settings)
    elif args.command == "rotate-token":
        token = rotate_token(settings.token_path)
        print("Yeni token üretildi. Tarayıcıyı yeniden eşleştirin:")
        for link in pair_links(settings, token):
            print("  " + link)
    elif args.command == "pair":
        for link in pair_links(settings, load_or_create_token(settings.token_path)):
            print(link)
    elif args.command == "install-agent":
        install_agent(settings)
    else:
        uninstall_agent()


if __name__ == "__main__":
    main()
