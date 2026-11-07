type AsenaLogoProps = {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
};

export function AsenaLogo({
  className = "",
  markClassName = "h-9 w-9",
  showWordmark = true,
}: AsenaLogoProps) {
  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <svg
        className={markClassName}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={showWordmark}
        role={showWordmark ? undefined : "img"}
      >
        {!showWordmark ? <title>Asena</title> : null}
        <rect width="40" height="40" rx="11" fill="currentColor" />
        {/* Voice bars: sound waveform mark */}
        <g fill="var(--asena-bg)">
          <rect x="9" y="16" width="3.2" height="8" rx="1.6" />
          <rect x="14.2" y="11.5" width="3.2" height="17" rx="1.6" />
          <rect x="19.4" y="8" width="3.2" height="24" rx="1.6" />
          <rect x="24.6" y="12.5" width="3.2" height="15" rx="1.6" />
          <rect x="29.8" y="16.5" width="3.2" height="7" rx="1.6" />
        </g>
        {/* Accent pulse on the tallest bar tip */}
        <circle cx="21" cy="8" r="1.6" fill="var(--asena-accent)" />
      </svg>
      {showWordmark ? (
        <span className="font-[family-name:var(--font-display)] text-[1.55rem] font-medium tracking-[-0.03em] text-current">
          asena
        </span>
      ) : null}
    </div>
  );
}
