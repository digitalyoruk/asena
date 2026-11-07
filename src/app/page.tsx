import Link from "next/link";
import { Play } from "lucide-react";
import { AsenaLogo } from "@/components/asena-logo";

export default function Home() {
  return (
    <div className="relative flex min-h-full flex-1 flex-col overflow-hidden bg-[var(--asena-bg)] text-[var(--asena-ink)]">
      <div className="pointer-events-none absolute inset-0 asena-atmosphere" aria-hidden />
      <div className="pointer-events-none absolute inset-0 asena-routes" aria-hidden />

      <header className="relative z-10 px-6 pt-8 sm:px-10 lg:px-16">
        <AsenaLogo className="asena-fade-in text-[var(--asena-ink)]" />
      </header>

      <main className="relative z-10 flex flex-1 flex-col justify-end px-6 pb-16 pt-24 sm:px-10 sm:pb-20 sm:pt-28 lg:px-16 lg:pb-24">
        <div className="max-w-2xl">
          <h1 className="asena-rise font-[family-name:var(--font-display)] text-[clamp(2.75rem,8vw,5.5rem)] leading-[0.95] tracking-[-0.04em] text-[var(--asena-ink)]">
            asena
          </h1>
          <p className="asena-rise asena-delay-1 mt-6 text-[clamp(1.15rem,2.4vw,1.45rem)] leading-relaxed text-[var(--asena-muted)]">
            Bankalar için kurye optimizasyonu ve AI ses asistanı.
          </p>
          <p className="asena-rise asena-delay-2 mt-5 max-w-xl text-[0.98rem] leading-relaxed text-[var(--asena-soft)]">
            Türk mitolojisinde Asena, soyu yok olmaktan kurtaran ve kabileye yol
            gösteren efsanevi dişi kurttur. Biz de bankacılığın Asenasıyız:
            operasyonu koruyan, yolu açan rehber.
          </p>
          <div className="asena-rise asena-delay-3 mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/demo"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[var(--asena-ink)] px-7 text-[0.95rem] font-medium text-[var(--asena-bg)] transition-transform duration-300 hover:scale-[1.02] active:scale-[0.98]"
            >
              <Play className="size-4 fill-current" aria-hidden />
              Canlı Dene
            </Link>
            <span className="text-sm text-[var(--asena-soft)]">
              Rota, Ses, Operasyon
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
