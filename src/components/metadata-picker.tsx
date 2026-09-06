import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type CSSProperties,
} from "react"
import { Popover } from "radix-ui"
import { useMobile } from "@/hooks/use-mobile"
import type { Media } from "@/lib/types"
import { Thumbnail } from "./thumbnail"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"

export function MetadataPicker({
  open,
  onOpenChange,
  trigger,
  title,
  media = [],
  bulk = false,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  title: string
  media?: Media[]
  bulk?: boolean
  children: ReactNode
}) {
  const mobile = useMobile()
  const drawer = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<{
    bottom: number
    height: number
  } | null>(null)
  useEffect(() => {
    if (!mobile || !open) return
    const viewport = window.visualViewport
    const update = () =>
      setViewport(
        viewport
          ? {
              bottom: Math.max(
                0,
                window.innerHeight - viewport.height - viewport.offsetTop
              ),
              height: viewport.height,
            }
          : null
      )
    update()
    viewport?.addEventListener("resize", update)
    viewport?.addEventListener("scroll", update)
    return () => {
      viewport?.removeEventListener("resize", update)
      viewport?.removeEventListener("scroll", update)
    }
  }, [mobile, open])

  if (!mobile)
    return (
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="tag-popover"
            sideOffset={8}
            align="start"
            collisionPadding={12}
            aria-label={title}
          >
            <h3>{title}</h3>
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    )
  const preview = media.slice(0, 5)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        ref={drawer}
        className="mobile-tag-drawer"
        overlayClassName="mobile-tag-overlay"
        style={
          viewport
            ? { bottom: viewport.bottom, maxHeight: viewport.height * 0.9 }
            : undefined
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          drawer.current?.focus()
        }}
      >
        <div className="mobile-tag-heading">
          <div className="drawer-handle" aria-hidden="true" />
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Check to add, uncheck to remove, or search to create. A dash means
            only some selected media have this item.
          </DialogDescription>
          {bulk ? (
            <>
              <div className="drawer-album" aria-hidden="true">
                {preview.map((item, index) => (
                  <div
                    className="drawer-media-thumbnail"
                    key={item.id}
                    style={
                      {
                        "--fan-offset": `${(index - (preview.length - 1) / 2) * 24}px`,
                        "--fan-angle": `${(index - (preview.length - 1) / 2) * 9}deg`,
                        zIndex: index,
                      } as CSSProperties
                    }
                  >
                    <Thumbnail
                      id={item.id}
                      name=""
                      video={item.mime_type.startsWith("video/")}
                      eager
                    />
                  </div>
                ))}
              </div>
              <span className="drawer-selection-count">
                {media.length} selected
              </span>
            </>
          ) : (
            media[0] && (
              <div className="drawer-media">
                <div className="drawer-media-thumbnail">
                  <Thumbnail
                    id={media[0].id}
                    name=""
                    video={media[0].mime_type.startsWith("video/")}
                    eager
                  />
                </div>
                <strong>{media[0].display_name}</strong>
              </div>
            )
          )}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function MembershipCheckbox({
  checked,
  label,
}: {
  checked: boolean | "mixed"
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "mixed"
  }, [checked])
  return (
    <input
      ref={ref}
      className="membership-checkbox"
      type="checkbox"
      checked={checked === true}
      aria-checked={checked}
      aria-label={label}
      readOnly
      tabIndex={-1}
    />
  )
}
