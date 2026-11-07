import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AsenaLogo } from "@/components/asena-logo";

export const metadata = {
  title: "Canlı Dene - Asena",
  description: "Asena canlı demo alanı.",
};

export default function DemoPage() {
  return (
    <div className="relative flex min-h-full flex-1 flex-col bg-[var(--asena-bg)] text-[var(--asena-ink)]">
      <div className="pointer-events-none absolute inset-0 asena-atmosphere" aria-hidden />

      <header className="relative z-10 flex flex-col items-start gap-4 px-6 pt-8 sm:px-10 lg:px-16">
        <Link href="/" aria-label="Ana sayfa">
          <AsenaLogo className="text-[var(--asena-ink)]" />
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--asena-soft)] transition-colors hover:text-[var(--asena-ink)]"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Geri
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-start justify-center px-6 py-16 sm:px-10 lg:px-16">
        <p className="text-sm tracking-wide text-[var(--asena-soft)] uppercase">
          Demo
        </p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(2rem,5vw,3.25rem)] leading-tight tracking-[-0.03em]">
          Canlı deneyim yakında
        </h1>
        <p className="mt-4 max-w-md text-[var(--asena-muted)] leading-relaxed">
          Bu alanda Asena ses asistanını ve kurye optimizasyonunu canlı
          deneyeceksin. Demo birazdan buraya gelecek.
        </p>
      </main>
    </div>
  );
}
