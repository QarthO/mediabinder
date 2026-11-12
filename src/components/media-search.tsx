import { memo, startTransition, useState, type RefObject } from "react"
import { useDebouncer } from "@tanstack/react-pacer"
import { Search, X } from "lucide-react"

export const MediaSearch = memo(function MediaSearch({
  label = "Search media",
  inputRef,
  mobile,
  expanded,
  onSearch,
  onClose,
}: {
  label?: string
  inputRef: RefObject<HTMLInputElement | null>
  mobile: boolean
  expanded: boolean
  onSearch: (value: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState("")
  const search = useDebouncer(
    (value: string) => startTransition(() => onSearch(value)),
    { wait: 150 }
  )
  const clear = () => {
    search.cancel()
    setDraft("")
    onSearch("")
    onClose()
  }
  return (
    <div className="filter-search">
      <Search size={15} />
      <input
        ref={inputRef}
        aria-label={label}
        placeholder={`${label}…`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          search.maybeExecute(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") clear()
          if (event.key === "Enter") search.flush()
        }}
      />
      {(draft || (mobile && expanded)) && (
        <button
          aria-label={mobile ? `Close ${label.toLowerCase()}` : "Clear search"}
          onClick={clear}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
})
