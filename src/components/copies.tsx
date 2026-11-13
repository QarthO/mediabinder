import { Fragment, memo, type Ref } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, ChevronRight, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "./ui/button"
import { action } from "@/lib/api"
import { bytes, dateValue } from "@/lib/utils"
import type { ItemCopy } from "@/lib/types"

/** A small muted "N copies" marker for the table and cards. Display only. */
export const CopyBadge = memo(function CopyBadge({ count }: { count: number }) {
  return <span className="copy-badge">{count} copies</span>
})

const copiesQuery = (id: string) => ({
  queryKey: ["copies", id],
  queryFn: () => action<ItemCopy[]>("copies", { id }),
  staleTime: 30_000,
})

const pathText = (location: ItemCopy["locations"][number]) =>
  [location.folder_name, ...(location.path ?? [])].join(" / ")

function Breadcrumb({ location }: { location: ItemCopy["locations"][number] }) {
  const crumbs = [location.folder_name, ...(location.path ?? [])]
  return (
    <ol className="copy-path" aria-label="Folder path">
      {crumbs.map((crumb, index) => (
        <Fragment key={index}>
          {index > 0 && <ChevronRight size={12} aria-hidden />}
          <li data-root={index === 0 || undefined}>{crumb}</li>
        </Fragment>
      ))}
      {location.path === null && (
        <li className="copy-path-pending">Path available after next sync</li>
      )}
    </ol>
  )
}

function CopyRow({ copy }: { copy: ItemCopy }) {
  const known = copy.locations.filter((location) => location.path !== null)
  return (
    <li className="copy-row">
      <div className="copy-locations">
        {copy.locations.map((location, index) => (
          <Breadcrumb key={index} location={location} />
        ))}
      </div>
      <strong className="copy-name">{copy.raw_name}</strong>
      <small className="copy-meta">
        {bytes(copy.size)} · {dateValue(copy.uploaded_at)}
      </small>
      <div className="copy-actions">
        <a
          href={`https://drive.google.com/file/d/${copy.drive_id}/view`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Drive
          <ArrowUpRight size={13} />
        </a>
        {known.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              navigator.clipboard
                .writeText(known.map(pathText).join("\n"))
                .then(
                  () => toast.success("Path copied"),
                  () => toast.error("Could not copy the path")
                )
            }}
          >
            <Copy />
            Copy path
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * Where each copy of an item lives in Drive. It mounts only for items with
 * more than one copy and fetches then, so the library payload never carries
 * this.
 */
export function CopiesSection({
  catalogId,
  count,
  ref,
}: {
  catalogId: string
  count: number
  ref?: Ref<HTMLElement>
}) {
  const copies = useQuery(copiesQuery(catalogId))
  return (
    <section
      id="detail-copies"
      className="detail-copies"
      ref={ref}
      tabIndex={-1}
      aria-labelledby="detail-copies-heading"
    >
      <div className="section-heading">
        <h3 id="detail-copies-heading">
          Copies <span>{count}</span>
        </h3>
      </div>
      {copies.isPending ? (
        <p className="muted">Loading copies…</p>
      ) : copies.isError ? (
        <div role="alert">
          <p className="muted">{copies.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => copies.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <ul className="copy-list">
          {copies.data.map((copy) => (
            <CopyRow key={copy.drive_id} copy={copy} />
          ))}
        </ul>
      )}
    </section>
  )
}
