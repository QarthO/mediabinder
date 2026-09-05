export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <svg
        width="29"
        height="29"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <path d="M8 5H25V27H8V5Z" fill="currentColor" fillOpacity=".12" />
        <path
          d="M8 5H25V27H8V5ZM12 5V27M5 11H10M5 21H10"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M16 12H21M16 17H21" stroke="currentColor" strokeWidth="2" />
      </svg>
      {!compact && (
        <span>
          Media<span className="brand-light">Binder</span>
        </span>
      )}
    </span>
  )
}
