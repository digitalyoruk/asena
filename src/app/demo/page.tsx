"use client";
import dynamic from "next/dynamic";
import Link from "next/link";

const Console = dynamic(() => import("@/components/console/Console"), {
  ssr: false,
  loading: () => <div className="p-8 text-sm text-muted-foreground">Yükleniyor…</div>,
});

export default function DemoPage() {
  return (
    <div className="min-h-full flex-1 bg-muted/30">
      <div className="mx-auto max-w-[1500px] px-4 pt-3 text-xs">
        <Link href="/" className="text-muted-foreground hover:text-foreground">← Ana sayfa</Link>
      </div>
      <Console />
    </div>
  );
}
