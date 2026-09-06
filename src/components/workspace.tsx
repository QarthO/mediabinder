import { FolderSelector } from "./folder-selector"
import { Select } from "./ui/select"
import { tagStyle } from "@/lib/tag-colors"
import {
  Outlet,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"
import { useEffect, useMemo, useState, useRef } from "react"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { type SortingState } from "@tanstack/react-table"
import { DataTable, useMediaTable } from "./data-table"
import {
  Tags,
  Images,
  ImageIcon,
  Film,
  FolderOpen,
  Link2,
  Search,
  Settings,
  RefreshCw,
  Plus,
  LayoutGrid,
  List,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  SlidersHorizontal,
  X,
  LogOut,
  LoaderCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "./ui/command"
import { Brand } from "./brand"
import { Thumbnail } from "./thumbnail"
import { Detail } from "./detail"
import { DriveSettings } from "./drive-settings"
import { libraryQuery, action } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { bytes } from "@/lib/utils"
import type { Media, MediaSet } from "@/lib/types"
const navItems = [
  { id: "all", label: "All media", icon: Images },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "videos", label: "Videos", icon: Film },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "sets", label: "Sets", icon: FolderOpen },
] as const
export function Workspace() {
  const query = useQuery(libraryQuery),
    client = useQueryClient()
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { folders: selectedFolders = [] } = useSearch({ from: "/_app" })
  const setId = pathname.startsWith("/sets/")
    ? decodeURIComponent(pathname.slice(6))
    : null
  const page = setId || pathname === "/media" ? "all" : pathname.slice(1)
  const [view, setView] = useState<"grid" | "list">("grid"),
    [search, setSearch] = useState(""),
    [tag, setTag] = useState(""),
    [sorting, setSorting] = useState<SortingState>([
      { id: "uploaded_at", desc: true },
    ]),
    [command, setCommand] = useState(false),
    [newSet, setNewSet] = useState(false),
    [setName, setSetName] = useState(""),
    [selected, setSelected] = useState<{
      id: string
      kind: "media" | "set"
    } | null>(null),
    [collapsed, setCollapsed] = useState(false)
  const changePage = (value: string) => {
    window.scrollTo({ top: 0 })
    void navigate({
      to: value === "all" ? "/media" : (`/${value}` as "/images"),
      search: { folders: selectedFolders },
    })
    setSearch("")
    setTag("")
    setCommand(false)
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "b" &&
        !e.repeat
      ) {
        e.preventDefault()
        setCollapsed((value) => !value)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setCommand((v) => !v)
      }
    }
    window.addEventListener("keydown", handler)
    const stored = localStorage.getItem("mediabinder-view")
    if (stored === "list") setView("list")
    return () => window.removeEventListener("keydown", handler)
  }, [])
  const sync = useMutation({
    mutationFn: (_automatic?: boolean) => action<{ count: number }>("sync"),
    onSuccess: async (result, automatic) => {
      await client.invalidateQueries({ queryKey: ["library"] })
      if (!automatic)
        toast.success(
          `Synced ${result.count} media ${result.count === 1 ? "item" : "items"}`
        )
    },
    onError: (e, automatic) => {
      if (!automatic || !e.message.startsWith("A sync")) toast.error(e.message)
    },
  })
  const freshSync = useRef(false)
  useEffect(() => {
    if (query.data && !freshSync.current) {
      freshSync.current = true
      if (query.data.workspace.sources.length) {
        sync.mutate(true)
      }
    }
  }, [query.data, client])
  useEffect(() => {
    setSearch("")
    setTag("")
    setSelected(null)
  }, [pathname])
  const createSet = useMutation({
    mutationFn: () =>
      action<{ id: string }>("create-set", { displayName: setName }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["library"] })
      setNewSet(false)
      setSetName("")
      changePage("sets")
      toast.success("Set created")
    },
    onError: (e) => toast.error(e.message),
  })
  const data = query.data
  useEffect(() => {
    if (data && setId && !data.sets.some((set) => set.id === setId)) {
      void navigate({ to: "/sets", search: { folders: selectedFolders } })
    }
  }, [data?.sets, setId])
  const catalogMedia = useMemo(
    () =>
      (data?.media ?? []).filter(
        (media) =>
          !selectedFolders.length ||
          media.source_ids.some((id) => selectedFolders.includes(id))
      ),
    [data?.media, selectedFolders]
  )
  useEffect(() => {
    if (!data || !selectedFolders.length) return
    const folders = selectedFolders.filter((id) =>
      data.workspace.sources.some((source) => source.folder_id === id)
    )
    if (folders.length !== selectedFolders.length)
      void navigate({
        to: pathname as "/media",
        search: { folders },
        replace: true,
      })
  }, [data?.workspace.sources, selectedFolders, pathname, navigate])
  const allTags = useMemo(
    () =>
      [
        ...new Set(
          [...catalogMedia, ...(data?.sets ?? [])].flatMap((m) => m.tags)
        ),
      ].sort(),
    [catalogMedia, data?.sets]
  )
  const scopedMedia = useMemo(
    () =>
      catalogMedia.filter(
        (m) =>
          (page !== "images" || m.mime_type.startsWith("image/")) &&
          (page !== "videos" || m.mime_type.startsWith("video/")) &&
          (!setId || m.set_ids.includes(setId)) &&
          (!tag || m.tags.includes(tag)) &&
          (!selectedFolders.length ||
            m.source_ids.some((id) => selectedFolders.includes(id)))
      ),
    [catalogMedia, page, setId, tag, selectedFolders]
  )
  const table = useMediaTable(
    scopedMedia,
    search,
    sorting,
    setSorting,
    (media) => setSelected({ id: media.id, kind: "media" }),
    allTags,
    data?.tag_colors ?? {}
  )
  const items = table.getRowModel().rows.map((row) => row.original)
  const sort =
    sorting[0]?.id === "uploaded_at"
      ? sorting[0].desc
        ? "newest"
        : "oldest"
      : sorting[0]?.id === "display_name" && !sorting[0].desc
        ? "name"
        : "custom"
  const currentSet = data?.sets.find((s) => s.id === setId)
  const title =
    currentSet?.display_name ??
    navItems.find((n) => n.id === page)?.label ??
    "Settings"
  const openSet = (set: MediaSet) => {
    window.scrollTo({ top: 0 })
    void navigate({
      to: "/sets/$setId",
      params: { setId: set.id },
      search: { folders: selectedFolders },
    })
    setSearch("")
    setTag("")
    setCommand(false)
  }
  const openMedia = (media: Media) =>
    setSelected({ id: media.id, kind: "media" })
  if (!data)
    return (
      <div className="loading-screen">
        <Brand />
        {query.isError ? (
          <>
            <p role="alert">{query.error.message}</p>
            <Button onClick={() => query.refetch()}>Retry</Button>
          </>
        ) : (
          <LoaderCircle className="spin" aria-label="Loading library" />
        )}
      </div>
    )
  const counts: Record<string, number> = {
    all: catalogMedia.length,
    images: catalogMedia.filter((m) => m.mime_type.startsWith("image/")).length,
    videos: catalogMedia.filter((m) => m.mime_type.startsWith("video/")).length,
    tags: allTags.length,
    sets: data.sets.length,
  }
  return (
    <div className={`app ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand compact={collapsed} />
        </div>
        <FolderSelector
          sources={data.workspace.sources}
          selected={selectedFolders}
          onChange={(folders) =>
            void navigate({ to: pathname as "/media", search: { folders } })
          }
          compact={collapsed}
        />
        <button
          className="search-trigger"
          onClick={() => setCommand(true)}
          aria-label="Search and commands"
        >
          <Search size={15} />
          {!collapsed && (
            <>
              <span>Search anything</span>
              <kbd>⌘ K</kbd>
            </>
          )}
        </button>
        <div className="nav-label">LIBRARY</div>
        <nav aria-label="Library">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              title={label}
              className={`nav-item ${page === id && !setId ? "active" : ""}`}
              onClick={() => changePage(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
              <small>{counts[id]}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="account">
            <div className="avatar">
              {data.user.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{data.user.name}</strong>
            </div>
            <button
              className={page === "settings" ? "active" : ""}
              title="Settings"
              aria-label="Settings"
              onClick={() => changePage("settings")}
            >
              <Settings size={17} />
            </button>
            <button
              title="Sign out of MediaBinder"
              aria-label="Sign out of MediaBinder"
              onClick={async () => {
                await authClient.signOut()
                window.location.assign("/")
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="header">
          <button
            className="icon-button"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <span className="header-divider" />
          <span className="muted">Library</span>
          <ChevronRight size={13} />
          <span className="breadcrumb">{title}</span>
        </header>
        <div
          className={`workspace-content ${["all", "images", "videos"].includes(page) ? "media-workspace" : ""}`}
        >
          {page === "settings" ? (
            <DriveSettings workspace={data.workspace} />
          ) : page === "tags" ? (
            <div className="tags-page">
              <div className="filter-search">
                <Search size={17} />
                <input
                  aria-label="Search tags"
                  placeholder="Find a tag…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="tag-grid">
                {allTags
                  .filter((value) => value.includes(search.toLowerCase()))
                  .map((value) => {
                    const matchingSets = data.sets.filter((set) =>
                      set.tags.includes(value)
                    )
                    const count = catalogMedia.filter((media) =>
                      media.tags.includes(value)
                    ).length
                    return (
                      <article className="tag-card" key={value}>
                        <button
                          onClick={() => {
                            changePage("all")
                            setTag(value)
                          }}
                        >
                          <Tags size={19} />
                          <strong style={{ color: data.tag_colors[value] }}>
                            {value}
                          </strong>
                          <span>
                            {count} media
                            <ChevronRight size={15} />
                          </span>
                        </button>
                        <label className="tag-color-control">
                          Color
                          <input
                            type="color"
                            aria-label={`Color for ${value}`}
                            value={data.tag_colors[value] ?? "#7dd3fc"}
                            onChange={(event) => {
                              void action("tag-color", {
                                name: value,
                                color: event.target.value,
                              })
                                .then(() =>
                                  client.invalidateQueries({
                                    queryKey: ["library"],
                                  })
                                )
                                .catch((error) => toast.error(error.message))
                            }}
                          />
                        </label>
                        {matchingSets.length > 0 && (
                          <div className="tag-sets">
                            {matchingSets.map((set) => (
                              <button key={set.id} onClick={() => openSet(set)}>
                                <FolderOpen size={14} />
                                {set.display_name}
                              </button>
                            ))}
                          </div>
                        )}
                      </article>
                    )
                  })}
              </div>
              {!allTags.length && (
                <Empty
                  icon={Tags}
                  title="A little easier to find"
                  description="Add tags when editing media or sets. They’ll appear here."
                />
              )}
              {allTags.length > 0 &&
                !allTags.some((value) =>
                  value.includes(search.toLowerCase())
                ) && <p className="muted">No tags match your search.</p>}
            </div>
          ) : page === "sets" ? (
            <>
              {data.sets.length ? (
                <div className="set-grid">
                  {data.sets.map((set) => (
                    <button
                      className="set-card"
                      key={set.id}
                      onClick={() => openSet(set)}
                    >
                      <div className="set-cover">
                        {set.cover_id ? (
                          <Thumbnail
                            id={set.cover_id}
                            name={set.display_name}
                          />
                        ) : (
                          <FolderOpen size={32} />
                        )}
                        <span className="set-tab">
                          <FolderOpen size={13} />
                          SET
                        </span>
                      </div>
                      <div className="set-info">
                        <strong>{set.display_name}</strong>
                        <span>
                          {set.media_count} items
                          <ChevronRight size={15} />
                        </span>
                      </div>
                      {set.tags.length > 0 && (
                        <div className="tags">
                          {set.tags.map((t) => (
                            <span
                              className="tag"
                              style={tagStyle(data.tag_colors[t])}
                              key={t}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={FolderOpen}
                  title="Give your media a little context"
                  description="Create a set for a shoot, a project, or anything that belongs together."
                  action={
                    <Button onClick={() => setNewSet(true)}>
                      <Plus />
                      Create a set
                    </Button>
                  }
                />
              )}
            </>
          ) : (
            <>
              <div className="library-toolbar">
                {currentSet && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      setSelected({ id: currentSet.id, kind: "set" })
                    }
                  >
                    <SlidersHorizontal />
                    Edit set
                  </Button>
                )}
                <div className="filter-search">
                  <Search size={15} />
                  <input
                    aria-label="Search media"
                    placeholder="Search media…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      aria-label="Clear search"
                      onClick={() => setSearch("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <Button
                  variant="outline"
                  disabled={sync.isPending || !data.workspace.sources.length}
                  onClick={() => sync.mutate()}
                >
                  <RefreshCw className={sync.isPending ? "spin" : ""} />
                  {sync.isPending ? "Syncing…" : "Sync Drive"}
                </Button>
                <Select
                  label="Filter by tag"
                  value={tag ? `tag:${tag}` : "all"}
                  onChange={(value) =>
                    setTag(value === "all" ? "" : value.slice(4))
                  }
                  options={[
                    { value: "all", label: "All tags" },
                    ...allTags.map((value) => ({
                      value: `tag:${value}`,
                      label: value,
                    })),
                  ]}
                />
                <div className="toolbar-spacer" />
                <Select
                  label="Sort media"
                  value={sort}
                  onChange={(value) =>
                    setSorting([
                      {
                        id: value === "name" ? "display_name" : "uploaded_at",
                        desc: value === "newest",
                      },
                    ])
                  }
                  options={[
                    { value: "newest", label: "Newest first" },
                    { value: "oldest", label: "Oldest first" },
                    { value: "name", label: "Name A–Z" },
                    ...(sort === "custom"
                      ? [{ value: "custom", label: "Custom sort" }]
                      : []),
                  ]}
                />
                <div className="view-switch">
                  {(["grid", "list"] as const).map((v) => (
                    <button
                      key={v}
                      aria-label={`${v === "grid" ? "Grid" : "List"} view`}
                      aria-pressed={view === v}
                      className={view === v ? "selected" : ""}
                      onClick={() => {
                        setView(v)
                        localStorage.setItem("mediabinder-view", v)
                      }}
                    >
                      {v === "grid" ? (
                        <LayoutGrid size={16} />
                      ) : (
                        <List size={17} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
              {tag && (
                <div className="active-filter">
                  <span className="tag" style={tagStyle(data.tag_colors[tag])}>
                    {tag}
                    <button
                      aria-label="Clear tag filter"
                      onClick={() => setTag("")}
                    >
                      <X size={11} />
                    </button>
                  </span>
                </div>
              )}
              {!items.length ? (
                <Empty
                  icon={setId ? FolderOpen : Images}
                  title={
                    search || tag
                      ? "No media found"
                      : setId
                        ? "This set is a blank canvas"
                        : data.workspace.sources.length
                          ? "Your library starts here"
                          : "Connect your Google Drive"
                  }
                  description={
                    search || tag
                      ? "Try a different name or tag."
                      : setId
                        ? "Open media from your library and add it to this set."
                        : data.workspace.sources.length
                          ? "Sync your folder to bring your images and videos into MediaBinder."
                          : "Choose a folder in settings, then sync to bring your images and videos together."
                  }
                  action={
                    !search && !tag && !setId ? (
                      <Button
                        disabled={sync.isPending}
                        onClick={() =>
                          data.workspace.sources.length
                            ? sync.mutate()
                            : changePage("settings")
                        }
                      >
                        {data.workspace.sources.length ? (
                          <RefreshCw />
                        ) : (
                          <FolderOpen />
                        )}
                        {data.workspace.sources.length
                          ? "Sync Drive"
                          : "Choose a folder"}
                      </Button>
                    ) : undefined
                  }
                />
              ) : view === "grid" ? (
                <div className="media-grid">
                  {items.map((media) => (
                    <button
                      key={media.id}
                      className="media-card"
                      onClick={() => openMedia(media)}
                    >
                      <div className="media-image">
                        <Thumbnail
                          id={media.id}
                          name={media.display_name}
                          video={media.mime_type.startsWith("video/")}
                        />
                        {media.mime_type.startsWith("video/") && (
                          <span className="media-type">
                            <Film size={12} />
                            {media.duration_ms
                              ? `${Math.floor(media.duration_ms / 60000)}:${String(Math.floor(media.duration_ms / 1000) % 60).padStart(2, "0")}`
                              : "VIDEO"}
                          </span>
                        )}
                        {!media.available && (
                          <span className="unavailable">
                            Unavailable in Drive
                          </span>
                        )}
                        {media.post_count > 0 && (
                          <span className="posted-indicator">
                            <Link2 size={11} />
                            {media.post_count}
                          </span>
                        )}
                      </div>
                      <div className="media-info">
                        <strong>{media.display_name}</strong>
                        <span>
                          {media.mime_type.startsWith("video/") ? (
                            <Film size={12} />
                          ) : (
                            <ImageIcon size={12} />
                          )}
                          <span>
                            {media.raw_name.split(".").pop()?.toUpperCase()}
                          </span>
                          <span className="dot-separator">·</span>
                          {bytes(media.size)}
                        </span>
                      </div>
                      {media.tags.length > 0 && (
                        <div className="tags">
                          {media.tags.slice(0, 3).map((t) => (
                            <span key={t} className="tag">
                              {t}
                            </span>
                          ))}
                          {media.tags.length > 3 && (
                            <span className="tag">
                              +{media.tags.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <DataTable
                  table={table}
                  allTags={allTags}
                  resetKey={`${page}:${setId}:${tag}:${search}`}
                />
              )}
            </>
          )}
        </div>
      </main>
      <Dialog open={newSet} onOpenChange={setNewSet}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a set</DialogTitle>
            <DialogDescription>
              A home for related images and videos.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              createSet.mutate()
            }}
          >
            <label className="field">
              Set name
              <Input
                autoFocus
                required
                maxLength={255}
                placeholder="e.g. Summer in the city"
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
              />
            </label>
            <div className="dialog-footer">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewSet(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={createSet.isPending || !setName.trim()}
                type="submit"
              >
                {createSet.isPending ? "Creating…" : "Create set"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={command} onOpenChange={setCommand}>
        <DialogContent className="command-dialog">
          <DialogTitle className="sr-only">Search and commands</DialogTitle>
          <DialogDescription className="sr-only">
            Navigate your library or find media and sets.
          </DialogDescription>
          <Command>
            <div className="command-search">
              <Search size={18} />
              <CommandInput
                placeholder="Search your library or jump to…"
                autoFocus
              />
            </div>
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Navigate">
                {navItems.map(({ id, label, icon: Icon }) => (
                  <CommandItem key={id} onSelect={() => changePage(id)}>
                    <Icon size={16} />
                    {label}
                    <ChevronRight size={14} />
                  </CommandItem>
                ))}
                <CommandItem onSelect={() => changePage("settings")}>
                  <Settings size={16} />
                  Settings
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setCommand(false)
                    setNewSet(true)
                  }}
                >
                  <Plus size={16} />
                  Create a set
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Media">
                {catalogMedia.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={`media ${m.display_name} ${m.raw_name} ${m.tags.join(" ")} ${m.id}`}
                    onSelect={() => {
                      setCommand(false)
                      openMedia(m)
                    }}
                  >
                    {m.mime_type.startsWith("video/") ? (
                      <Film size={16} />
                    ) : (
                      <ImageIcon size={16} />
                    )}
                    <span>{m.display_name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Sets">
                {data.sets.map((s) => (
                  <CommandItem key={s.id} onSelect={() => openSet(s)}>
                    <FolderOpen size={16} />
                    {s.display_name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="command-footer">
              <span>↑ ↓ to navigate</span>
              <span>↵ to open</span>
              <span>esc to close</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
      <Outlet />
      {selected && (
        <Detail
          key={`${selected.kind}-${selected.id}`}
          selected={selected}
          data={data}
          navigation={
            selected.kind === "media" &&
            items.some((item) => item.id === selected.id)
              ? {
                  index: items.findIndex((item) => item.id === selected.id),
                  count: items.length,
                  onStep: (direction) => {
                    const next =
                      items[
                        items.findIndex((item) => item.id === selected.id) +
                          direction
                      ]
                    if (next) openMedia(next)
                  },
                }
              : undefined
          }
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
function Empty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Images
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={27} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  )
}
