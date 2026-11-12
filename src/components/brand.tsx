export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand" aria-label={compact ? "MediaBinder" : undefined}>
      <img
        src="/favicon.svg"
        width="32"
        height="32"
        alt=""
        aria-hidden="true"
      />
      {!compact && (
        <span>
          Media<span className="brand-light">Binder</span>
        </span>
      )}
    </span>
  )
}
