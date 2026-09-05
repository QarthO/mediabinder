import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import {
  getCoreRowModel,
  useReactTable,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table"
import {
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
  ArrowUpRight,
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
import { bytes, dateValue } from "@/lib/utils"
import type { Media, MediaSet } from "@/lib/types"
const navItems = [
  { id: "all", label: "All media", icon: Images },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "videos", label: "Videos", icon: Film },
  { id: "sets", label: "Sets", icon: FolderOpen },
  { id: "posts", label: "Posts", icon: Link2 },
] as const
export function Workspace() {
  const query = useQuery(libraryQuery),
    client = useQueryClient()
  const [page, setPage] = useState("all"),
    [view, setView] = useState<"grid" | "list">("grid"),
    [search, setSearch] = useState(""),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState("newest"),
    [command, setCommand] = useState(false),
    [newSet, setNewSet] = useState(false),
    [setName, setSetName] = useState(""),
    [selected, setSelected] = useState<{
      id: string
      kind: "media" | "set"
    } | null>(null),
    [collapsed, setCollapsed] = useState(false),
    [setId, setSetId] = useState<string | null>(null)
  const changePage = (value: string) => {
    setPage(value)
    setSetId(null)
    setSearch("")
    setTag("")
    setCommand(false)
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
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
    mutationFn: () => action<{ count: number }>("sync"),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["library"] })
      toast.success(
        `Synced ${result.count} media ${result.count === 1 ? "item" : "items"}`
      )
    },
    onError: (e) => toast.error(e.message),
  })
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
      setSetId(null)
      setPage("sets")
    }
  }, [data?.sets, setId])
  const allTags = useMemo(
    () => [...new Set(data?.media.flatMap((m) => m.tags) ?? [])].sort(),
    [data?.media]
  )
  const items = useMemo(() => {
    const term = search.toLowerCase()
    return (data?.media ?? [])
      .filter(
        (m) =>
          (page !== "images" || m.mime_type.startsWith("image/")) &&
          (page !== "videos" || m.mime_type.startsWith("video/")) &&
          (!setId || m.set_ids.includes(setId)) &&
          (!tag || m.tags.includes(tag)) &&
          (!term ||
            [m.display_name, m.raw_name, ...m.tags].some((t) =>
              t.toLowerCase().includes(term)
            ))
      )
      .sort((a, b) =>
        sort === "name"
          ? a.display_name.localeCompare(b.display_name)
          : sort === "oldest"
            ? a.uploaded_at.localeCompare(b.uploaded_at)
            : b.uploaded_at.localeCompare(a.uploaded_at)
      )
  }, [data?.media, page, setId, tag, search, sort])
  const currentSet = data?.sets.find((s) => s.id === setId)
  const title =
    currentSet?.display_name ??
    navItems.find((n) => n.id === page)?.label ??
    "Settings"
  const openSet = (set: MediaSet) => {
    setPage("all")
    setSetId(set.id)
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
    all: data.media.length,
    images: data.media.filter((m) => m.mime_type.startsWith("image/")).length,
    videos: data.media.filter((m) => m.mime_type.startsWith("video/")).length,
    sets: data.sets.length,
    posts: data.posts.length,
  }
  return (
    <div className={`app ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand compact={collapsed} />
        </div>
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
        <div className="nav-label sets-label">
          <span>YOUR SETS</span>
          <button
            aria-label="Create set"
            title="Create set"
            onClick={() => setNewSet(true)}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav aria-label="Your sets">
          {data.sets.slice(0, 12).map((set) => (
            <button
              key={set.id}
              title={set.display_name}
              className={`nav-item ${setId === set.id ? "active" : ""}`}
              onClick={() => openSet(set)}
            >
              <span className="set-dot" />
              <span>{set.display_name}</span>
              <small>{set.media_count}</small>
            </button>
          ))}
          {!data.sets.length && !collapsed && (
            <button className="empty-sets" onClick={() => setNewSet(true)}>
              Create your first set <Plus size={12} />
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="drive-status">
            <span
              className={`status-dot ${data.workspace.folder_id ? "connected" : ""}`}
            />
            <span>{data.workspace.folder_name ?? "Drive not configured"}</span>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            title="Settings"
            onClick={() => changePage("settings")}
          >
            <Settings size={17} />
            <span>Settings</span>
          </button>
          <div className="account">
            <div className="avatar">
              {data.user.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{data.user.name}</strong>
              <small>
                {data.user.role === "superuser" ? "Superuser" : "Member"}
              </small>
            </div>
            <button
              title="Sign out of MediaBinder"
              aria-label="Sign out of MediaBinder"
              onClick={async () => {
                await authClient.signOut()
                window.location.assign("/login")
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
          <div className="header-right">
            <span className="sync-status">
              {sync.isPending
                ? "Syncing Drive…"
                : data.workspace.last_synced_at
                  ? `Synced ${dateValue(data.workspace.last_synced_at)}`
                  : "Ready when you are"}
            </span>
            <button
              className="icon-button"
              title="Search and commands (⌘K)"
              aria-label="Open command menu"
              onClick={() => setCommand(true)}
            >
              <Search size={17} />
            </button>
          </div>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "settings"
                  ? "PREFERENCES"
                  : setId
                    ? "YOUR SET"
                    : "YOUR LIBRARY"}
              </div>
              <h1>
                {title}
                <span className="heading-count">
                  {page === "settings"
                    ? ""
                    : setId
                      ? items.length
                      : counts[page]}
                </span>
              </h1>
              <p>
                {page === "settings"
                  ? "Make yourself at home."
                  : setId
                    ? "A collection of things that belong together."
                    : page === "sets"
                      ? "Bring related media together, your way."
                      : page === "posts"
                        ? "Keep track of where your media goes."
                        : "Every image. Every video. All in one place."}
              </p>
            </div>
            <div className="heading-actions">
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
              {page !== "settings" && (
                <>
                  <Button
                    variant="outline"
                    disabled={sync.isPending || !data.workspace.folder_id}
                    onClick={() => sync.mutate()}
                  >
                    <RefreshCw className={sync.isPending ? "spin" : ""} />
                    Sync Drive
                  </Button>
                  <Button onClick={() => setNewSet(true)}>
                    <Plus />
                    New set
                  </Button>
                </>
              )}
            </div>
          </div>
          {page === "settings" ? (
            <DriveSettings workspace={data.workspace} />
          ) : page === "posts" ? (
            <div className="posts-page">
              {data.posts.length ? (
                <>
                  <div className="section-caption">
                    {data.posts.length} linked posts
                  </div>
                  {data.posts.map((post) => {
                    const target =
                      data.media.find((m) => m.id === post.media_id) ??
                      data.sets.find((s) => s.id === post.set_id)
                    return (
                      <div className="post-row" key={post.id}>
                        <div className="post-icon">
                          <Link2 size={18} />
                        </div>
                        <div>
                          <strong>{post.platform}</strong>
                          <button
                            className="text-button"
                            onClick={() =>
                              setSelected({
                                id: (post.media_id ?? post.set_id)!,
                                kind: post.media_id ? "media" : "set",
                              })
                            }
                          >
                            {target?.display_name ?? "View item"}
                          </button>
                        </div>
                        <span>{dateValue(post.created_at)}</span>
                        <a
                          href={post.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="external-link"
                        >
                          View post <ArrowUpRight size={15} />
                        </a>
                      </div>
                    )
                  })}
                </>
              ) : (
                <Empty
                  icon={Link2}
                  title="Your posts, connected"
                  description="Open an image, video, or set and add a post link to keep its story together."
                />
              )}
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
                            <span className="tag" key={t}>
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
                <select
                  aria-label="Filter by tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  <option value="">All tags</option>
                  {allTags.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <div className="toolbar-spacer" />
                <select
                  aria-label="Sort media"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">Name A–Z</option>
                </select>
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
                  <span className="tag">
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
                        : data.workspace.folder_id
                          ? "Your library starts here"
                          : "Connect your Google Drive"
                  }
                  description={
                    search || tag
                      ? "Try a different name or tag."
                      : setId
                        ? "Open media from your library and add it to this set."
                        : data.workspace.folder_id
                          ? "Sync your folder to bring your images and videos into MediaBinder."
                          : "Choose a folder in settings, then sync to bring your images and videos together."
                  }
                  action={
                    !search && !tag && !setId ? (
                      <Button
                        disabled={sync.isPending}
                        onClick={() =>
                          data.workspace.folder_id
                            ? sync.mutate()
                            : changePage("settings")
                        }
                      >
                        {data.workspace.folder_id ? (
                          <RefreshCw />
                        ) : (
                          <FolderOpen />
                        )}
                        {data.workspace.folder_id
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
                <MediaTable items={items} onOpen={openMedia} />
              )}
              <div className="library-footer">
                <span>
                  {items.length} {items.length === 1 ? "item" : "items"}
                  {setId ? " in this set" : ""}
                </span>
                <span>
                  Originals stay in Google Drive <ArrowUpRight size={12} />
                </span>
              </div>
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
                {data.media.map((m) => (
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
      {selected && (
        <Detail
          key={`${selected.kind}-${selected.id}`}
          selected={selected}
          data={data}
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
function MediaTable({
  items,
  onOpen,
}: {
  items: Media[]
  onOpen: (media: Media) => void
}) {
  const columns = useMemo<ColumnDef<Media>[]>(
    () => [
      {
        accessorKey: "display_name",
        header: "Name",
        cell: ({ row }) => (
          <button className="table-name" onClick={() => onOpen(row.original)}>
            <div className="table-thumbnail">
              <Thumbnail id={row.original.id} name="" />
            </div>
            <div>
              <strong>{row.original.display_name}</strong>
              <small>{row.original.raw_name}</small>
            </div>
          </button>
        ),
      },
      {
        accessorKey: "tags",
        header: "Tags",
        cell: ({ row }) => (
          <div className="tags">
            {row.original.tags.slice(0, 2).map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        ),
      },
      {
        accessorKey: "uploaded_at",
        header: "Uploaded",
        cell: ({ row }) => dateValue(row.original.uploaded_at),
      },
      {
        accessorKey: "size",
        header: "Size",
        cell: ({ row }) => bytes(row.original.size),
      },
      { accessorKey: "post_count", header: "Posts" },
    ],
    [onOpen]
  )
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })
  return (
    <div className="table-scroll">
      <table>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id}>
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
