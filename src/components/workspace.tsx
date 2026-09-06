import { flushSync } from "react-dom"
import { useMobile } from "@/hooks/use-mobile"
import { SidebarTags } from "./sidebar-tags"
import { FolderSelector } from "./folder-selector"
import { SearchSelect } from "./ui/search-select"
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
import {
  DataTable,
  MediaTags,
  MediaSelectionActions,
  useMediaTable,
} from "./data-table"
import {
  ArrowUpDown,
  Inbox,
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
  { id: "sets", label: "Sets", icon: FolderOpen },
  { id: "all", label: "All media", icon: Images },
] as const
export function Workspace() {
  const mobile = useMobile()
  const [selectionEnabled, setSelectionMode] = useState(false)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [mobileSearch, setMobileSearch] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const sidebarButton = useRef<HTMLButtonElement>(null)
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
    [selectedTags, setSelectedTags] = useState<string[]>([]),
    [mediaType, setMediaType] = useState("all"),
    [catalogStatus, setCatalogStatus] = useState("all"),
    [setFilter, setSetFilter] = useState(""),
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
  const selectionMode = (mobile || view === "grid") && selectionEnabled
  const sidebarCollapsed = !mobile && collapsed
  const toggleSidebar = () => {
    if (mobile) setMobileSidebar((value) => !value)
    else setCollapsed((value) => !value)
  }
  const changePage = (value: string) => {
    setMobileSidebar(false)
    window.scrollTo({ top: 0 })
    void navigate({
      to: value === "all" ? "/media" : (`/${value}` as "/media"),
      search: { folders: selectedFolders },
    })
    setSearch("")
    setSelectedTags([])
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
        if (window.matchMedia("(max-width: 760px)").matches)
          setMobileSidebar((value) => !value)
        else setCollapsed((value) => !value)
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
    setSetFilter("")
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
          (catalogStatus === "all" ||
            (catalogStatus === "cataloged" ? m.cataloged : !m.cataloged)) &&
          (mediaType !== "images" || m.mime_type.startsWith("image/")) &&
          (mediaType !== "videos" || m.mime_type.startsWith("video/")) &&
          (!setId || m.set_ids.includes(setId)) &&
          (!selectedTags.length ||
            selectedTags.some((tag) => m.tags.includes(tag))) &&
          (!setFilter || m.set_ids.includes(setFilter)) &&
          (!selectedFolders.length ||
            m.source_ids.some((id) => selectedFolders.includes(id)))
      ),
    [
      catalogMedia,
      mediaType,
      catalogStatus,
      setId,
      selectedTags,
      setFilter,
      selectedFolders,
    ]
  )
  const table = useMediaTable(
    scopedMedia,
    search,
    sorting,
    setSorting,
    (media) => setSelected({ id: media.id, kind: "media" }),
    allTags,
    data?.tag_colors ?? {},
    data?.sets ?? [],
    selectionMode
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
    setMobileSidebar(false)
    window.scrollTo({ top: 0 })
    void navigate({
      to: "/sets/$setId",
      params: { setId: set.id },
      search: { folders: [] },
    })
    setSearch("")
    setSelectedTags([])
    setMediaType("all")
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
    sets: data.sets.length,
  }
  const sidebar = (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Brand compact={sidebarCollapsed} />
      </div>
      <button
        className="search-trigger"
        onClick={() => {
          setMobileSidebar(false)
          setCommand(true)
        }}
        aria-label="Search and commands"
      >
        <Search size={15} />
        {!sidebarCollapsed && (
          <>
            <span>Search anything</span>
            <kbd>⌘ K</kbd>
          </>
        )}
      </button>
      <FolderSelector
        sources={data.workspace.sources}
        selected={selectedFolders}
        onChange={(folders) =>
          void navigate({ to: pathname as "/media", search: { folders } })
        }
        compact={sidebarCollapsed}
      />
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
      <SidebarTags
        tags={allTags}
        selected={selectedTags}
        colors={data.tag_colors}
        counts={Object.fromEntries(
          allTags.map((tag) => [
            tag,
            catalogMedia.filter((media) => media.tags.includes(tag)).length,
          ])
        )}
        compact={sidebarCollapsed}
        onExpand={() => setCollapsed(false)}
        onChange={(tags) => {
          setSelectedTags(tags)
          if (page !== "all") {
            setSearch("")
            setMediaType("all")
            void navigate({
              to: "/media",
              search: { folders: selectedFolders },
            })
          }
        }}
        onColor={(name, color) => {
          void action("tag-color", { name, color })
            .then(() => client.invalidateQueries({ queryKey: ["library"] }))
            .catch((error) => toast.error(error.message))
        }}
      />
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
  )
  return (
    <div
      className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${!sidebarCollapsed ? "sidebar-filter-open" : ""}`}
    >
      {mobile ? (
        <Dialog open={mobileSidebar} onOpenChange={setMobileSidebar}>
          <DialogContent
            className="mobile-sidebar-drawer"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              sidebarButton.current?.focus()
            }}
          >
            <DialogTitle className="sr-only">Library sidebar</DialogTitle>
            <DialogDescription className="sr-only">
              Choose folders, media, sets, or tag filters.
            </DialogDescription>
            {sidebar}
          </DialogContent>
        </Dialog>
      ) : (
        sidebar
      )}
      <main className="main">
        <header className="header">
          <button
            className="icon-button"
            ref={sidebarButton}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
            aria-expanded={mobile ? mobileSidebar : !collapsed}
            onClick={toggleSidebar}
          >
            {mobile || collapsed ? (
              <PanelLeft size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
          </button>
          <span className="header-divider" />
          <span className="muted">Library</span>
          <ChevronRight size={13} />
          <span className="breadcrumb">{title}</span>
          {page === "all" && (mobile || view === "grid") && (
            <Button
              className="header-select"
              variant="outline"
              aria-pressed={selectionMode}
              onClick={() => {
                setSelectionMode(!selectionMode)
                table.resetRowSelection()
              }}
            >
              {selectionMode ? "Done" : "Select"}
            </Button>
          )}
          {currentSet && (
            <Button
              variant="outline"
              className="header-set-edit"
              aria-label="Edit set"
              onClick={() => setSelected({ id: currentSet.id, kind: "set" })}
            >
              <SlidersHorizontal />
              <span>Edit set</span>
            </Button>
          )}
          <Button
            className="header-sync"
            variant="outline"
            aria-label={sync.isPending ? "Syncing Drive" : "Sync Drive"}
            disabled={sync.isPending || !data.workspace.sources.length}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={sync.isPending ? "spin" : ""} />
            <span>{sync.isPending ? "Syncing…" : "Sync Drive"}</span>
          </Button>
        </header>
        <div
          className={`workspace-content ${page === "all" ? "media-workspace" : ""}`}
        >
          {page === "settings" ? (
            <DriveSettings workspace={data.workspace} />
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
              <div
                className={`library-toolbar ${mobileSearch ? "mobile-search-open" : ""}`}
              >
                <button
                  className="mobile-search-toggle icon-button"
                  aria-label="Open media search"
                  onClick={() => {
                    flushSync(() => setMobileSearch(true))
                    searchInput.current?.focus()
                  }}
                >
                  <Search size={18} />
                </button>
                <div className="filter-search">
                  <Search size={15} />
                  <input
                    ref={searchInput}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setMobileSearch(false)
                        setSearch("")
                      }
                    }}
                    aria-label="Search media"
                    placeholder="Search media…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {(search || (mobile && mobileSearch)) && (
                    <button
                      aria-label={
                        mobile ? "Close media search" : "Clear search"
                      }
                      onClick={() => {
                        setSearch("")
                        setMobileSearch(false)
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <Select
                  label="Filter by media type"
                  mobileIcon={Images}
                  value={mediaType}
                  onChange={setMediaType}
                  options={[
                    { value: "all", label: "All types" },
                    { value: "images", label: "Images" },
                    { value: "videos", label: "Videos" },
                  ]}
                />
                <Select
                  label="Filter by catalog status"
                  mobileIcon={Inbox}
                  value={catalogStatus}
                  onChange={setCatalogStatus}
                  options={[
                    { value: "all", label: "All content" },
                    { value: "uncataloged", label: "Uncataloged" },
                    { value: "cataloged", label: "Cataloged" },
                  ]}
                />
                <SearchSelect
                  label="Filter by set"
                  mobileIcon={FolderOpen}
                  value={setFilter || "all"}
                  onChange={(value) =>
                    setSetFilter(value === "all" ? "" : value)
                  }
                  options={[
                    { value: "all", label: "All sets" },
                    ...data.sets.map((set) => ({
                      value: set.id,
                      label: set.display_name,
                    })),
                  ]}
                />
                <div className="toolbar-spacer" />
                <Select
                  label="Sort media"
                  mobileIcon={ArrowUpDown}
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
              {selectedTags.length > 0 && (
                <div className="active-filter">
                  {selectedTags.map((tag) => (
                    <span
                      key={tag}
                      className="tag"
                      style={tagStyle(data.tag_colors[tag])}
                    >
                      {tag}
                      <button
                        aria-label={`Clear ${tag} filter`}
                        onClick={() =>
                          setSelectedTags(
                            selectedTags.filter((value) => value !== tag)
                          )
                        }
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div
                className="media-stage"
                data-selecting={selectionMode || undefined}
                data-has-selection={
                  table.getFilteredSelectedRowModel().rows.length > 0 ||
                  undefined
                }
              >
                {!items.length ? (
                  <Empty
                    icon={setId ? FolderOpen : Images}
                    title={
                      search ||
                      selectedTags.length ||
                      setFilter ||
                      mediaType !== "all" ||
                      catalogStatus !== "all"
                        ? "No media found"
                        : setId
                          ? "This set is a blank canvas"
                          : data.workspace.sources.length
                            ? "Your library starts here"
                            : "Connect your Google Drive"
                    }
                    description={
                      search ||
                      selectedTags.length ||
                      setFilter ||
                      mediaType !== "all" ||
                      catalogStatus !== "all"
                        ? "Try a different name, tag, or set."
                        : setId
                          ? "Open media from your library and add it to this set."
                          : data.workspace.sources.length
                            ? "Sync your folder to bring your images and videos into MediaBinder."
                            : "Choose a folder in settings, then sync to bring your images and videos together."
                    }
                    action={
                      !search &&
                      !selectedTags.length &&
                      !setFilter &&
                      !setId &&
                      mediaType === "all" &&
                      catalogStatus === "all" ? (
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
                      <div
                        key={media.id}
                        className="media-card"
                        data-selected={
                          table.getRow(media.id).getIsSelected() || undefined
                        }
                      >
                        {!mobile && (
                          <input
                            className="media-card-checkbox"
                            type="checkbox"
                            aria-label={`Select ${media.display_name}`}
                            checked={table.getRow(media.id).getIsSelected()}
                            onChange={() =>
                              table.getRow(media.id).toggleSelected()
                            }
                          />
                        )}
                        <button
                          className="media-card-open"
                          aria-pressed={
                            selectionMode
                              ? table.getRow(media.id).getIsSelected()
                              : undefined
                          }
                          onClick={() =>
                            selectionMode
                              ? table.getRow(media.id).toggleSelected()
                              : openMedia(media)
                          }
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
                                {media.copy_count > 1 &&
                                  ` · ${media.copy_count} copies`}
                              </span>
                              <span className="dot-separator">·</span>
                              {bytes(media.size)}
                            </span>
                          </div>
                        </button>
                        <div className="media-card-tags">
                          <MediaTags
                            media={media}
                            allTags={allTags}
                            colors={data.tag_colors}
                            compact
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <DataTable
                    table={table}
                    resetKey={`${page}:${setId}:${selectedTags.join(",")}:${setFilter}:${mediaType}:${catalogStatus}:${search}`}
                  />
                )}
                <MediaSelectionActions table={table} allTags={allTags} />
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
