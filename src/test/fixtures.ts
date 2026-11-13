import { randomUUID } from "node:crypto"
import type { RowDataPacket } from "mysql2/promise"
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vite-plus/test"

import { auth } from "@/lib/auth.server"
import { NotFoundError, ValidationError } from "@/effect/errors"
import { Database } from "@/effect/database"
import { errorResponse } from "@/lib/http-errors"
import { runTracedAppEffect } from "@/effect/runtime.server"
import * as Drive from "@/lib/drive.server"
import * as Library from "@/lib/library.server"

type Value = string | number | boolean | Date | null

/** Reads rows through the app's Database service, as a Promise. */
export const rows = <T>(sql: string, values: Array<Value> = []) =>
  runTracedAppEffect(
    Database.use((database) =>
      database.queryRows<RowDataPacket>("test.query", sql, values)
    )
  ) as Promise<T[]>

/** Runs one statement through the app's Database service, as a Promise. */
export const execute = (sql: string, values: Array<Value> = []) =>
  runTracedAppEffect(
    Database.use((database) => database.execute("test.execute", sql, values))
  )

/** `Drive.sync` for a Promise caller. */
export const syncDrive = (userId: string) =>
  runTracedAppEffect(Drive.sync(userId))

export type TestUser = Parameters<typeof Library.load>[0]

/** `Library.load` for a Promise caller: what the library route returns. */
export const library = (user: TestUser) =>
  runTracedAppEffect(Library.load(user))

export const newUser = (name = "Test user"): TestUser => {
  const id = randomUUID()
  return { id, name, email: `${id}@example.com`, role: "user" }
}

/** A user with a row in Better Auth's table, for code that looks them up. */
export async function insertUser(name = "Test user"): Promise<TestUser> {
  const user = newUser(name)
  await execute(
    "INSERT INTO user(id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,TRUE,'user',NOW(),NOW())",
    [user.id, user.name, user.email]
  )
  return user
}

/** `mutate` as the signed-in user, the way the library route calls it. */
export const act = (user: { id: string }, action: string, input: unknown) =>
  runTracedAppEffect(Library.mutate(action, input, user.id, new Headers()))

export async function insertFolder(
  userId: string,
  folderId: string,
  name = folderId
) {
  await execute(
    "INSERT INTO drive_folder(user_id,folder_id,folder_name) VALUES (?,?,?)",
    [userId, folderId, name]
  )
}

/**
 * One available copy of a catalog item. `folder` links the copy to a linked
 * folder; sharing the `catalogId` makes two copies one library item.
 */
export async function insertMedia(options: {
  userId: string
  id?: string
  catalogId?: string
  name?: string
  tags?: string[]
  folder?: string
  uploadedAt?: string
  available?: boolean
}) {
  const id = options.id ?? randomUUID()
  const catalogId = options.catalogId ?? id
  const name = options.name ?? "Fixture"
  const uploadedAt = options.uploadedAt ?? "2026-09-01"
  await execute(
    "INSERT IGNORE INTO catalog(id,display_name,tags,created_at) VALUES (?,?,?,NOW(3))",
    [catalogId, name, JSON.stringify(options.tags ?? [])]
  )
  await execute(
    `INSERT INTO media(id,user_id,drive_id,catalog_id,display_name,raw_name,mime_type,tags,created_at,uploaded_at,size,available,synced_at)
    VALUES (?,?,?,?,?,'fixture.jpg','image/jpeg','[]',NOW(3),?,42,?,NOW(3))`,
    [
      id,
      options.userId,
      id,
      catalogId,
      name,
      uploadedAt,
      options.available ?? true,
    ]
  )
  if (options.folder)
    await execute(
      "INSERT INTO media_source(user_id,folder_id,media_id) VALUES (?,?,?)",
      [options.userId, options.folder, id]
    )
  return id
}

export async function insertSet(
  userId: string,
  catalogIds: string[],
  name = "Set"
) {
  const id = randomUUID()
  await execute(
    "INSERT INTO media_set(id,user_id,display_name,raw_name,tags,created_at) VALUES (?,?,?,?,'[]',NOW(3))",
    [id, userId, name, name]
  )
  for (const catalogId of catalogIds)
    await execute("INSERT INTO catalog_set_member VALUES (?,?)", [
      id,
      catalogId,
    ])
  return id
}

export const count = async (sql: string, values: (string | number)[] = []) =>
  Number(
    (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, values))[0].n
  )

type FetchHandler = (
  url: URL,
  init: RequestInit
) => Response | Promise<Response>

/**
 * Replaces `fetch`, the one seam to Google, for the suite. Effect's HTTP
 * client keeps the first `fetch` it sees, so the spy stays installed for the
 * whole file and each test only swaps its answer; the answer is cleared after
 * every test so a forgotten route fails loudly.
 */
export function stubGoogle() {
  let handler: FetchHandler | undefined
  let spy: { mockRestore: () => void } | undefined
  beforeAll(() => {
    spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (!handler) throw new Error(`Unexpected fetch: ${String(input)}`)
        return handler(new URL(String(input)), init ?? {})
      })
  })
  afterEach(() => {
    handler = undefined
  })
  afterAll(() => spy?.mockRestore())
  return (next: FetchHandler) => {
    handler = next
  }
}

/** Better Auth's token lookup, the other external seam to Google. */
export function stubAccessToken(
  token: (userId?: string) => string = () => "token"
) {
  let spy: { mockRestore: () => void } | undefined
  beforeEach(() => {
    spy = vi
      .spyOn(auth.api, "getAccessToken")
      .mockImplementation((async (options?: {
        body?: { userId?: string }
      }) => ({ accessToken: token(options?.body?.userId) })) as never)
  })
  afterEach(() => spy?.mockRestore())
}

/** Better Auth's session lookup, which the API routes sign requests in with. */
export function stubSession() {
  let spy: { mockRestore: () => void } | undefined
  let current: { id: string } | null = null
  beforeEach(() => {
    current = null
    spy = vi
      .spyOn(auth.api, "getSession")
      .mockImplementation((async () =>
        current ? { user: current, session: {} } : null) as never)
  })
  afterEach(() => spy?.mockRestore())
  return (user: { id: string } | null) => {
    current = user
  }
}

/**
 * The HTTP status a server function rejects with: the library throws a
 * `Response` for "not found" (also what another user's data looks like) and
 * "bad request". Fails the test if the promise resolves or rejects otherwise.
 */
export async function rejectedStatus(promise: Promise<unknown>) {
  const outcome = await promise.then(
    () => "resolved" as const,
    (error: unknown) => error
  )
  // Converted modules fail with tagged errors, answered with their status.
  if (outcome instanceof NotFoundError || outcome instanceof ValidationError)
    return errorResponse(outcome).status
  if (!(outcome instanceof Response))
    throw new Error(`Expected a rejected Response, got ${String(outcome)}`)
  return outcome.status
}

/**
 * A route's HTTP handler as the server calls it. Routes declare their
 * handlers as a record or a function, which is awkward to call from a test.
 */
export function routeHandler<Context>(
  route: { options: unknown },
  method: "GET" | "POST"
) {
  const server = (route.options as { server?: { handlers?: unknown } }).server
  const handler = (
    server?.handlers as
      | Record<string, ((context: Context) => Promise<Response>) | undefined>
      | undefined
  )?.[method]
  if (!handler) throw new Error(`Route has no ${method} handler`)
  return handler
}
