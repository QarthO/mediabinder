import { resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vite-plus/test"

// Every API route and server function is reachable by anyone who can send an
// HTTP request, so each handler must reach `requireSession` (directly or
// through the helpers it calls). Endpoints that are public on purpose are
// listed here with the reason. An entry that stops being needed, because the
// handler now checks the session or no longer exists, must come off the list.
const publicRouteHandlers: Record<string, string> = {
  "api.health.ts:GET": "The container health check; reveals only up or down",
  "api.drive.webhook.ts:POST":
    "Google's push notification, authorized by the channel token it carries",
  "api.auth.$.ts:GET": "Better Auth's catch-all: sign-in and session endpoints",
  "api.auth.$.ts:POST":
    "Better Auth's catch-all: sign-in and session endpoints",
}

const publicServerFunctions: Record<string, string> = {
  "index.tsx:loginStatus":
    "Tells the login page whether to redirect; returns only a signed-in flag",
  "_app.tsx:sessionCheck":
    "The shell's redirect check; returns the visitor's own view cookies and a signed-in flag, never library data",
  "development-auth.ts:enableDevelopmentLogin":
    "Skip login for development: sets the bypass cookie, and only when the stack is in dev mode and NODE_ENV is not production",
  "development-auth.ts:clearDevelopmentLogin":
    "Signing out of the bypass: clears the visitor's own cookie and returns whether it was set",
  "__root.tsx:browserTelemetryConfig":
    "Tells the page whether to send browser telemetry; returns only the trace sample ratio, or null",
}

const root = resolve(import.meta.dirname, "../..")
const authFile = resolve(root, "src/lib/auth.server.ts")
const libraryFile = resolve(root, "src/lib/library.server.ts")
const libraryHttpFile = resolve(root, "src/lib/library-http.ts")
const operationFile = resolve(root, "src/effect/operation.ts")
const routesDir = resolve(root, "src/routes")

const { program, checker } = loadProgram()

describe("API authentication", () => {
  it("authenticates every API route handler", { timeout: 60_000 }, () => {
    const reaches = reachabilityChecker(checker, isSessionCheck)
    const handlers = routeHandlers(program)
    expect(handlers.length).toBeGreaterThan(4)

    const unauthenticated = handlers
      .filter(
        ({ id, handler }) => !(id in publicRouteHandlers) && !reaches(handler)
      )
      .map(({ id }) => id)
    expect(unauthenticated).toEqual([])

    // A public entry that is gone, or that now checks the session, comes off.
    const stale = Object.keys(publicRouteHandlers).filter((id) => {
      const handler = handlers.find((candidate) => candidate.id === id)
      return !handler || reaches(handler.handler)
    })
    expect(stale).toEqual([])
  })

  it("authenticates every server function", { timeout: 60_000 }, () => {
    const reaches = reachabilityChecker(checker, isSessionCheck)
    const handlers = serverFunctionHandlers(program)
    expect(handlers.length).toBeGreaterThan(1)

    const unauthenticated = handlers
      .filter(
        ({ id, handler }) => !(id in publicServerFunctions) && !reaches(handler)
      )
      .map(({ id }) => id)
    expect(unauthenticated).toEqual([])

    const stale = Object.keys(publicServerFunctions).filter((id) => {
      const handler = handlers.find((candidate) => candidate.id === id)
      return !handler || reaches(handler.handler)
    })
    expect(stale).toEqual([])
  })

  // The library action table is the one way to change a library. Its handlers
  // get only the user id `libraryPost` took from the session, so these
  // checks pin the three links of that chain.
  describe("library actions", () => {
    it("lists actions that all take the session's user", async () => {
      // Loading the table loads Better Auth, which needs the app's URL.
      process.env.MEDIABINDER_URL ??= "http://localhost:3100"
      const { actions } = await import("./library.server")
      expect(Object.keys(actions).length).toBeGreaterThan(10)
      // `mutation()` is what hands a handler its `MutationContext`.
      const table = actionTableEntries(program)
      expect(table.map(({ name }) => name).sort()).toEqual(
        Object.keys(actions).sort()
      )
      expect(
        table.filter(({ viaMutation }) => !viaMutation).map(({ name }) => name)
      ).toEqual([])
    })

    it("runs them with the user id from libraryPost's session", () => {
      const file = program.getSourceFile(libraryHttpFile)!
      const calls: ts.CallExpression[] = []
      const sessionVariables = new Set<string>()
      const visit = (node: ts.Node) => {
        // const session = yield* dependencies.session(request.headers)
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isYieldExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isCallExpression(node.initializer.expression) &&
          node.initializer.expression.expression.getText() ===
            "dependencies.session"
        )
          sessionVariables.add(node.name.text)
        if (
          ts.isCallExpression(node) &&
          node.expression.getText() === "dependencies.mutate"
        )
          calls.push(node)
        ts.forEachChild(node, visit)
      }
      visit(file)
      expect([...sessionVariables]).toEqual(["session"])
      // The only caller of `dependencies.mutate`, with the user id as the
      // third argument and nothing the client sent.
      expect(calls).toHaveLength(1)
      expect(calls[0].arguments[2].getText()).toBe("session.user.id")
    })

    it("is reached only through libraryPost, which the route signs in", () => {
      const callers = new Set<string>()
      for (const file of sourceFiles(program)) {
        // Test helpers call it directly, as the tests' stand-in for the route.
        if (
          file.fileName === libraryFile ||
          file.fileName.includes("/src/test/")
        )
          continue
        const visit = (node: ts.Node) => {
          if (
            ts.isIdentifier(node) &&
            (node.text === "mutate" || node.text === "actions") &&
            !(
              ts.isPropertyAccessExpression(node.parent) &&
              node.parent.name === node &&
              node.parent.expression.getText() === "dependencies"
            ) &&
            resolvesTo(node, libraryFile)
          )
            callers.add(file.fileName.slice(root.length + 1))
          ts.forEachChild(node, visit)
        }
        visit(file)
      }
      // The route hands `mutate` to libraryPost along with `requireSession`
      // as its session; the script is a manual check run by an operator.
      expect([...callers].sort()).toEqual([
        "scripts/try-shared-folder-link.ts",
        "src/routes/api.library.ts",
      ])
      const route = program.getSourceFile(resolve(routesDir, "api.library.ts"))!
      const post = routeHandlers(program).find(
        ({ id }) => id === "api.library.ts:POST"
      )!
      const text = post.handler.getText(route)
      expect(text).toMatch(/session:\s*requireSession/)
      expect(text).toMatch(/\bmutate\b/)
      expect(text).toMatch(/libraryPost\(/)
    })
  })
})

function loadProgram() {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        )
      },
    }
  )
  if (!config) throw new Error("Could not read tsconfig.json")
  const program = ts.createProgram({
    rootNames: config.fileNames.filter(
      (file) =>
        (file.includes("/src/") || file.includes("/scripts/")) &&
        !/\.test\.tsx?$/.test(file)
    ),
    options: config.options,
  })
  return { program, checker: program.getTypeChecker() }
}

function sourceFiles(program: ts.Program) {
  return program
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        (file.fileName.startsWith(resolve(root, "src")) ||
          file.fileName.startsWith(resolve(root, "scripts")))
    )
}

interface Handler {
  readonly id: string
  readonly handler: ts.Node
}

// `server: { handlers: { GET: fn, POST: fn } }` in src/routes/api.*.ts
function routeHandlers(program: ts.Program) {
  const handlers: Array<Handler> = []
  for (const file of sourceFiles(program)) {
    const name = file.fileName.split("/").at(-1)!
    if (!file.fileName.startsWith(routesDir) || !/^api\..*\.ts$/.test(name))
      continue
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "handlers" &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const method of node.initializer.properties) {
          if (
            !ts.isPropertyAssignment(method) &&
            !ts.isMethodDeclaration(method)
          )
            throw new Error(`${name} declares a handler this test can't read`)
          handlers.push({
            id: `${name}:${(method.name as ts.Identifier).text}`,
            handler: method,
          })
        }
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return handlers
}

function serverFunctionHandlers(program: ts.Program) {
  const handlers: Array<Handler> = []
  for (const file of sourceFiles(program)) {
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        createsServerFunction(node.initializer)
      ) {
        const handler = handlerArgument(node.initializer)
        if (!handler) throw new Error(`${node.name.text} has no handler`)
        handlers.push({
          id: `${file.fileName.split("/").at(-1)}:${node.name.text}`,
          handler,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return handlers
}

function createsServerFunction(node: ts.Expression): boolean {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression))
      return node.expression.text === "createServerFn"
    return createsServerFunction(node.expression)
  }
  return ts.isPropertyAccessExpression(node)
    ? createsServerFunction(node.expression)
    : false
}

// `createServerFn(...).validator(...).handler(fn)` -> fn
function handlerArgument(node: ts.Expression): ts.Node | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "handler")
    return node.arguments[0]
  return ts.isPropertyAccessExpression(callee)
    ? handlerArgument(callee.expression)
    : undefined
}

// The properties of the object literals `actions` is built from, and whether
// each is a call to `mutation(...)` from effect/operation.ts.
function actionTableEntries(program: ts.Program) {
  const file = program.getSourceFile(libraryFile)!
  const literals = new Map<string, ts.ObjectLiteralExpression>()
  let spread: Array<string> = []
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        if (node.name.text === "actions")
          spread = node.initializer.properties.flatMap((property) =>
            ts.isSpreadAssignment(property)
              ? [property.expression.getText()]
              : []
          )
        else literals.set(node.name.text, node.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(spread.length).toBeGreaterThan(0)
  return spread.flatMap((name) => {
    const literal = literals.get(name)
    if (!literal)
      throw new Error(`actions spreads ${name}, which isn't a literal`)
    return literal.properties.map((property) => {
      if (!ts.isPropertyAssignment(property))
        throw new Error("An action isn't a plain property")
      const key = ts.isStringLiteral(property.name)
        ? property.name.text
        : (property.name as ts.Identifier).text
      const call = property.initializer
      return {
        name: key,
        viaMutation:
          ts.isCallExpression(call) &&
          ts.isIdentifier(call.expression) &&
          resolvesTo(call.expression, operationFile),
      }
    })
  })
}

function resolvesTo(identifier: ts.Identifier, file: string) {
  let symbol = checker.getSymbolAtLocation(identifier)
  if (!symbol) return false
  if (symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol)
  return (symbol.declarations ?? []).some(
    (declaration) => declaration.getSourceFile().fileName === file
  )
}

function isSessionCheck(declaration: ts.Node) {
  return (
    declaration.getSourceFile().fileName === authFile &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === "requireSession"
  )
}

// Whether code reaches a target declaration through the functions it
// references, following imports (including `await import(...)`
// destructuring) across the app's source.
function reachabilityChecker(
  checker: ts.TypeChecker,
  isTarget: (declaration: ts.Node) => boolean
) {
  const memo = new Map<ts.Node, boolean>()

  const reaches = (root: ts.Node): boolean => {
    const cached = memo.get(root)
    if (cached !== undefined) return cached
    memo.set(root, false)
    let found = false
    const visit = (node: ts.Node) => {
      if (found) return
      if (ts.isIdentifier(node)) {
        for (const declaration of declarationsOf(node)) {
          if (isTarget(declaration) || reaches(declaration)) {
            found = true
            return
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    memo.set(root, found)
    return found
  }

  const declarationsOf = (identifier: ts.Identifier): Array<ts.Node> => {
    // Only follow references. A guard that is destructured or imported but
    // never used must not count as reaching it.
    if (isDeclarationName(identifier)) return []
    let symbol = checker.getSymbolAtLocation(identifier)
    if (!symbol) return []
    if (symbol.flags & ts.SymbolFlags.Alias)
      symbol = checker.getAliasedSymbol(symbol)
    return (symbol.declarations ?? []).flatMap((declaration) => {
      if (ts.isBindingElement(declaration))
        return dynamicImportExport(declaration)
      return isSourceDeclaration(declaration) ? [declaration] : []
    })
  }

  // `const { name } = await import("@/x")` -> the export.
  const dynamicImportExport = (element: ts.BindingElement): Array<ts.Node> => {
    const pattern = element.parent
    const owner = pattern.parent
    if (!ts.isVariableDeclaration(owner) || !owner.initializer) return []
    const value = ts.isAwaitExpression(owner.initializer)
      ? owner.initializer.expression
      : owner.initializer
    if (
      !ts.isCallExpression(value) ||
      value.expression.kind !== ts.SyntaxKind.ImportKeyword
    )
      return []
    const moduleSymbol = checker.getSymbolAtLocation(value.arguments[0])
    if (!moduleSymbol) return []
    const exportName = (element.propertyName ?? element.name) as ts.Identifier
    let exported = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === exportName.text)
    if (!exported) return []
    if (exported.flags & ts.SymbolFlags.Alias)
      exported = checker.getAliasedSymbol(exported)
    return (exported.declarations ?? []).filter(isSourceDeclaration)
  }

  return reaches
}

function isSourceDeclaration(node: ts.Node) {
  const file = node.getSourceFile()
  return (
    !file.isDeclarationFile && file.fileName.startsWith(resolve(root, "src"))
  )
}

function isDeclarationName(identifier: ts.Identifier) {
  const parent = identifier.parent
  if (
    ts.isBindingElement(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  )
    return parent.name === identifier || parent.propertyName === identifier
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isPropertyAccessExpression(parent)
  )
    return parent.name === identifier
  return false
}
