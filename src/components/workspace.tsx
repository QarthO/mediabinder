import { LibraryFilters } from "./library-filters"
import { MediaGrid } from "./media-grid"
import { useMediaPreviewIntent } from "@/lib/media-preview"
import { MediaSearch } from "./media-search"
import { flushSync } from "react-dom"
import { useMobile } from "@/hooks/use-mobile"
import { SidebarTags } from "./sidebar-tags"
import { FolderSelector } from "./folder-selector"
import { tagStyle } from "@/lib/tag-colors"
import {
  Outlet,
  useNavigate,
  useRouterState,
  useSearch,
  useRouteContext,
} from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useMemo, useState, useRef } from "react"
import {
  useSuspenseQuery,
  useQueryClient,
  useMutation,
} from "@tanstack/react-query"
import { type SortingState, type OnChangeFn } from "@tanstack/react-table"
import { DataTable, MediaSelectionActions, useMediaTable } from "./data-table"
import {
  Images,
  ImageIcon,
  Film,
  FolderOpen,
  Search,
  Settings,
  RefreshCw,
  Plus,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  SlidersHorizontal,
  X,
  LogOut,
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
import { Thumbnail, MediaCensorContext } from "./thumbnail"
const Detail = lazy(() =>
  import("./detail").then((module) => ({ default: module.Detail }))
)
const DriveSettings = lazy(() =>
  import("./drive-settings").then((module) => ({
    default: module.DriveSettings,
  }))
)
import { libraryQuery, action } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import {
  workspacePreferencesCookie,
  type WorkspacePreferences,
} from "@/lib/workspace-preferences"
import type { Media, MediaSet } from "@/lib/types"
const navItems = [
  { id: "sets", label: "Sets", icon: FolderOpen },
  { id: "all", label: "All media", icon: Images },
] as const
export function Workspace() {
  const { preferences: initialPreferences } = useRouteContext({ from: "/_app" })
  const [preferences, setPreferences] =
    useState<WorkspacePreferences>(initialPreferences)
  const savePreferences = (next: WorkspacePreferences) => {
    document.cookie = workspacePreferencesCookie(
      next,
      window.location.protocol === "https:"
    )
    setPreferences(next)
  }
  const setSorting: OnChangeFn<SortingState> = (update) =>
    savePreferences({
      ...preferences,
      sorting:
        typeof update === "function" ? update(preferences.sorting) : update,
    })
  return (
    <MediaCensorContext value={preferences.censored}>
      <WorkspaceContent
        mediaCensored={preferences.censored}
        onToggleCensor={() =>
          savePreferences({ ...preferences, censored: !preferences.censored })
        }
        sorting={preferences.sorting}
        setSorting={setSorting}
      />
    </MediaCensorContext>
  )
}

function WorkspaceContent({
  mediaCensored,
  onToggleCensor,
  sorting,
  setSorting,
}: {
  mediaCensored: boolean
  onToggleCensor: () => void
  sorting: SortingState
  setSorting: OnChangeFn<SortingState>
}) {
  const { view: initialView } = useRouteContext({ from: "/_app" })
  const previewIntent = useMediaPreviewIntent()
  const mobile = useMobile()
  const [selectionEnabled, setSelectionMode] = useState(false)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const [mobileSearch, setMobileSearch] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const query = useSuspenseQuery(libraryQuery),
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
  const [view, setView] = useState<"grid" | "list">(initialView),
    [search, setSearch] = useState(""),
    [searchVersion, setSearchVersion] = useState(0),
    [selectedTags, setSelectedTags] = useState<string[]>([]),
    [mediaType, setMediaType] = useState("all"),
    [catalogStatus, setCatalogStatus] = useState("all"),
    [setFilter, setSetFilter] = useState(""),
    [command, setCommand] = useState(false),
    [newSet, setNewSet] = useState(false),
    [setName, setSetName] = useState(""),
    [selected, setSelected] = useState<{
      id: string
      kind: "media" | "set"
    } | null>(null),
    [collapsed, setCollapsed] = useState(false)
  const clearSearch = useCallback(() => {
    setSearch("")
    setSearchVersion((value) => value + 1)
  }, [])
  const changeView = useCallback((view: "grid" | "list") => {
    setView(view)
    document.cookie = `mediabinder_view=${view}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`
  }, [])
  const closeSearch = useCallback(() => setMobileSearch(false), [])
  const selectionMode = (mobile || view === "grid") && selectionEnabled
  const sidebarCollapsed = !mobile && collapsed
  const toggleSidebar = () => {
    if (mobile) setMobileSidebar((value) => !value)
    else setCollapsed((value) => !value)
  }
  const changePage = useCallback(
    (value: string) => {
      setMobileSidebar(false)
      window.scrollTo({ top: 0 })
      void navigate({
        to: value === "all" ? "/media" : (`/${value}` as "/media"),
        search: { folders: selectedFolders },
      })
      clearSearch()
      setSelectedTags([])
      setCommand(false)
    },
    [navigate, selectedFolders, clearSearch]
  )
  const keyboardShortcuts = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    performance.mark("mediabinder-interactive")
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
  const [previousPath, setPreviousPath] = useState(pathname)
  if (previousPath !== pathname) {
    setPreviousPath(pathname)
    clearSearch()
    setSetFilter("")
    setSelected(null)
  }
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
  const catalogMedia = useMemo(
    () =>
      (data?.media ?? []).filter(
        (media) =>
          !selectedFolders.length ||
          media.source_ids.some((id) => selectedFolders.includes(id))
      ),
    [data?.media, selectedFolders]
  )
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
  const openMedia = useCallback(
    (media: Media) => setSelected({ id: media.id, kind: "media" }),
    []
  )
  const table = useMediaTable(
    scopedMedia,
    search,
    sorting,
    setSorting,
    openMedia,
    allTags,
    data?.tag_colors ?? {},
    data?.sets ?? [],
    selectionMode
  )
  const rows = table.getRowModel().rows
  const items = useMemo(() => rows.map((row) => row.original), [rows])
  const toggleSelection = useCallback(
    (id: string) => table.getRow(id).toggleSelected(),
    [table]
  )
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const media of catalogMedia)
      for (const tag of media.tags) counts[tag] = (counts[tag] ?? 0) + 1
    return counts
  }, [catalogMedia])
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
    clearSearch()
    setSelectedTags([])
    setMediaType("all")
    setCommand(false)
  }
  const counts: Record<string, number> = {
    all: catalogMedia.length,
    sets: data.sets.length,
  }
  const sidebar = useMemo(
    () => (
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
          counts={tagCounts}
          compact={sidebarCollapsed}
          onExpand={() => setCollapsed(false)}
          onChange={(tags) => {
            setSelectedTags(tags)
            if (page !== "all") {
              clearSearch()
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
    ),
    [
      sidebarCollapsed,
      selectedFolders,
      pathname,
      navigate,
      data.workspace.sources,
      data.user,
      data.sets.length,
      data.tag_colors,
      catalogMedia.length,
      page,
      setId,
      allTags,
      selectedTags,
      tagCounts,
      changePage,
      clearSearch,
      client,
    ]
  )
  return (
    <div
      ref={keyboardShortcuts}
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
          {page === "all" && (
            <Button
              className={`header-select ${view === "list" ? "mobile-only-selection" : ""}`}
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
            <Suspense
              fallback={<div className="empty-state">Loading settings…</div>}
            >
              <DriveSettings workspace={data.workspace} />
            </Suspense>
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
                <MediaSearch
                  key={searchVersion}
                  inputRef={searchInput}
                  mobile={mobile}
                  expanded={mobileSearch}
                  onSearch={setSearch}
                  onClose={closeSearch}
                />
                <LibraryFilters
                  mediaType={mediaType}
                  setMediaType={setMediaType}
                  catalogStatus={catalogStatus}
                  setCatalogStatus={setCatalogStatus}
                  setFilter={setFilter}
                  setSetFilter={setSetFilter}
                  sets={data.sets}
                  sort={sort}
                  setSorting={setSorting}
                  mediaCensored={mediaCensored}
                  onToggleCensor={onToggleCensor}
                  view={view}
                  onView={changeView}
                />
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
                  <MediaGrid
                    key={`${page}:${setId}:${selectedTags.join(",")}:${setFilter}:${mediaType}:${catalogStatus}:${search}`}
                    items={items}
                    selection={table.getState().rowSelection}
                    previewIntent={previewIntent}
                    mobile={mobile}
                    selectionMode={selectionMode}
                    onOpen={openMedia}
                    onToggleSelection={toggleSelection}
                    allTags={allTags}
                    colors={data.tag_colors}
                  />
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
      {newSet && (
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
      )}
      {command && (
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
      )}
      <Outlet />
      {selected && (
        <Suspense fallback={null}>
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
        </Suspense>
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
