import { memo, startTransition, useState, type RefObject } from "react"
import { useDebouncer } from "@tanstack/react-pacer"
import { Search, X } from "lucide-react"

export const MediaSearch = memo(function MediaSearch({
  inputRef,
  mobile,
  expanded,
  onSearch,
  onClose,
}: {
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
        aria-label="Search media"
        placeholder="Search media…"
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
          aria-label={mobile ? "Close media search" : "Clear search"}
          onClick={clear}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
})
