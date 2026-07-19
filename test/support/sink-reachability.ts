/**
 * Issue #772 — Part 2: mechanical sink-reachability analysis.
 *
 * This is the recurrence-prevention half of #772. Instead of trusting a
 * hand-maintained list of "tools that sign or broadcast", it MECHANICALLY
 * walks — via the TypeScript AST — the function-level call graph rooted at
 * every `registerTool(server, "<name>", …, <handler>)` site in
 * `src/index.ts`, and reports whether that graph reaches a device-signing
 * or broadcast SINK.
 *
 * Why function-granularity (not module-granularity): almost every tool
 * handler is a thin wrapper exported from the single large module
 * `src/modules/execution/index.ts`, which statically imports every broadcast
 * helper. A module-closure walk would therefore flag ~every tool. We instead
 * follow the ACTUAL calls a handler makes — including the `const { fn } =
 * await import("…")` dynamic-import wrappers those handlers use — so
 * `combine_btc_psbts` (calls `combinePsbts`) is correctly distinguished from
 * `finalize_btc_psbt` (calls `finalizePsbt`, which calls
 * `indexer.broadcastTx`), even though both live in the same file.
 *
 * SINKS detected (issue #772's named set):
 *   - `.broadcastTx(`               (Bitcoin indexer mainnet broadcast)
 *   - `broadcastSolanaTx(` / `broadcastTronTx(`  (Solana / TRON broadcast)
 *   - `.signPsbt(` / `.signPsbtBuffer(`          (Ledger BTC / LTC signature)
 *   - `.signTransaction(`           (Ledger Solana / TRON signature)
 *   - a call carrying `method: "eth_sendTransaction"`  (WalletConnect EVM
 *     broadcast — the precise request site, not the pairing method allowlist)
 *
 * BOUNDS (documented limitations — this is a strong bounded approximation,
 * not a whole-program type-checker):
 *   1. Resolution is name-based per file: a call `foo(...)` is resolved
 *      through that file's static imports, the enclosing function's dynamic
 *      `await import()` bindings, then same-file top-level declarations. It
 *      does NOT follow values through parameters, higher-order callbacks,
 *      re-exports (`export * from`), or computed/`.call`/`.apply` dispatch.
 *   2. Sinks are matched by call-site shape in a reached function body
 *      (property-access name, bare-identifier name, or the WC method literal).
 *      A sink invoked purely through a value passed in as a parameter would
 *      be missed.
 *   3. Only relative (`./…`) imports are followed; bare/`node_modules`
 *      specifiers are not descended into (every sink CALL site in this repo
 *      lives in a `src/` file, so this loses nothing for the covered sinks).
 *
 * These bounds are conservative for the security property that matters: the
 * two known escapees (`sign_btc_multisig_psbt`, `finalize_btc_psbt`) and the
 * gated control (`send_transaction`) are all detected. If the approximation
 * ever fails to detect a genuinely sink-reaching NEW tool, the accompanying
 * test's explicit "these must be detected as sink-reaching" assertions are
 * the tripwire that the analysis regressed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const INDEX_TS = path.join(SRC_ROOT, "index.ts");

/** Property-access sink method names (`x.<name>(...)`). */
const PROP_SINKS = new Set(["broadcastTx", "signPsbt", "signPsbtBuffer", "signTransaction"]);
/** Bare-identifier sink function names (`<name>(...)`). */
const IDENT_SINKS = new Set(["broadcastSolanaTx", "broadcastTronTx"]);
/** WalletConnect broadcast request literal. */
const WC_METHOD = "eth_sendTransaction";

const sfCache = new Map<string, ts.SourceFile | null>();

function getSourceFile(absPath: string): ts.SourceFile | null {
  if (sfCache.has(absPath)) return sfCache.get(absPath) ?? null;
  let sf: ts.SourceFile | null = null;
  try {
    const text = fs.readFileSync(absPath, "utf8");
    sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  } catch {
    sf = null;
  }
  sfCache.set(absPath, sf);
  return sf;
}

/** Resolve a relative module specifier from an importing file to an on-disk `.ts` file. */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // only follow src-local relative imports
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base + ".ts",
    path.join(base.replace(/\.js$/, ""), "index.ts"),
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

interface Ref {
  file: string;
  name: string;
}

/**
 * Static top-level imports of a file: local binding name → {file, exportedName}.
 * Namespace imports (`import * as ns`) map the namespace name with a wildcard
 * marker so `ns.foo()` can be resolved to (file, foo).
 */
function staticImports(sf: ts.SourceFile): Map<string, { file: string; name: string; namespace?: boolean }> {
  const out = new Map<string, { file: string; name: string; namespace?: boolean }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modFile = resolveModule(sf.fileName, stmt.moduleSpecifier.text);
    if (!modFile) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      out.set(clause.name.text, { file: modFile, name: "default" });
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      out.set(named.name.text, { file: modFile, name: "*", namespace: true });
    } else if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const local = el.name.text;
        const exported = el.propertyName ? el.propertyName.text : el.name.text;
        out.set(local, { file: modFile, name: exported });
      }
    }
  }
  return out;
}

/**
 * Dynamic `const { a, b: c } = await import("mod")` (and `const ns = await
 * import("mod")`) bindings inside a function body: local name → {file, exportedName}.
 */
function dynamicImports(fnBody: ts.Node, fromFile: string): Map<string, { file: string; name: string; namespace?: boolean }> {
  const out = new Map<string, { file: string; name: string; namespace?: boolean }>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      const importCall = ts.isAwaitExpression(init) ? init.expression : init;
      if (
        ts.isCallExpression(importCall) &&
        importCall.expression.kind === ts.SyntaxKind.ImportKeyword &&
        importCall.arguments.length === 1 &&
        ts.isStringLiteral(importCall.arguments[0])
      ) {
        const modFile = resolveModule(fromFile, importCall.arguments[0].text);
        if (modFile) {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const local = el.name.text;
                const exported =
                  el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : local;
                out.set(local, { file: modFile, name: exported });
              }
            }
          } else if (ts.isIdentifier(node.name)) {
            out.set(node.name.text, { file: modFile, name: "*", namespace: true });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fnBody);
  return out;
}

/** Find a top-level function-like declaration by exported/local name. */
function findFunction(sf: ts.SourceFile, name: string): ts.Node | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) {
      return stmt;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === name &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

/** True if this function-like node's own body contains a sink call-site. */
function bodyHasSink(fnNode: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && PROP_SINKS.has(callee.name.text)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(callee) && IDENT_SINKS.has(callee.text)) {
        found = true;
        return;
      }
      // WalletConnect: any call carrying `{ method: "eth_sendTransaction" }`.
      for (const arg of node.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              ((ts.isIdentifier(p.name) && p.name.text === "method") ||
                (ts.isStringLiteral(p.name) && p.name.text === "method")) &&
              ts.isStringLiteral(p.initializer) &&
              p.initializer.text === WC_METHOD
            ) {
              found = true;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fnNode);
  return found;
}

/**
 * Collect the callee references made inside a function body, resolved to
 * {file, exportedName} via (dynamic imports ∪ static imports ∪ same-file
 * top-level functions). Handles both `foo(...)` and `ns.foo(...)` where `ns`
 * is a namespace import.
 */
function resolvedCallees(
  fnNode: ts.Node,
  ownerFile: string,
): Ref[] {
  const sf = getSourceFile(ownerFile);
  if (!sf) return [];
  const dyn = dynamicImports(fnNode, ownerFile);
  const stat = staticImports(sf);
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const push = (r: { file: string; name: string } | null) => {
    if (!r) return;
    const key = `${r.file}#${r.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(r);
  };
  const resolveName = (name: string): { file: string; name: string } | null => {
    const d = dyn.get(name);
    if (d && !d.namespace) return { file: d.file, name: d.name };
    const s = stat.get(name);
    if (s && !s.namespace) return { file: s.file, name: s.name };
    // same-file top-level function
    if (findFunction(sf, name)) return { file: ownerFile, name };
    return null;
  };
  const resolveNsMember = (ns: string, member: string): { file: string; name: string } | null => {
    const d = dyn.get(ns);
    if (d && d.namespace) return { file: d.file, name: member };
    const s = stat.get(ns);
    if (s && s.namespace) return { file: s.file, name: member };
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        push(resolveName(callee.text));
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        push(resolveNsMember(callee.expression.text, callee.name.text));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fnNode);
  return refs;
}

/**
 * DFS: does the call graph rooted at `fnNode` (declared in `ownerFile`)
 * reach a sink? Returns the reaching path (function names) for diagnostics.
 */
function reachesSinkFromNode(
  fnNode: ts.Node,
  ownerFile: string,
  visited: Set<string>,
  trail: string[],
): string[] | null {
  if (bodyHasSink(fnNode)) return trail;
  for (const ref of resolvedCallees(fnNode, ownerFile)) {
    const key = `${ref.file}#${ref.name}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const sf = getSourceFile(ref.file);
    if (!sf) continue;
    const callee = findFunction(sf, ref.name);
    if (!callee) continue;
    const hit = reachesSinkFromNode(callee, ref.file, visited, [
      ...trail,
      `${path.relative(REPO_ROOT, ref.file)}#${ref.name}`,
    ]);
    if (hit) return hit;
  }
  return null;
}

export interface ToolSinkResult {
  name: string;
  sinkReaching: boolean;
  sinkPath: string[] | null;
}

/**
 * Extract every `registerTool(server, "<name>", <opts>, <handlerExpr>)` from
 * `src/index.ts` and resolve the root handler function(s) for each, then run
 * the reachability DFS.
 */
export function analyzeRegisteredTools(): ToolSinkResult[] {
  const index = getSourceFile(INDEX_TS);
  if (!index) throw new Error(`could not parse ${INDEX_TS}`);
  const indexStatics = staticImports(index);
  const results: ToolSinkResult[] = [];

  // Resolve a root expression (the handler arg) into analyzable roots.
  const rootsFromExpr = (expr: ts.Expression): { node: ts.Node; file: string }[] => {
    const roots: { node: ts.Node; file: string }[] = [];
    const addIdentifier = (name: string) => {
      // Resolve through index.ts static imports, else a same-file function.
      const s = indexStatics.get(name);
      if (s && !s.namespace) {
        const sf = getSourceFile(s.file);
        const fn = sf ? findFunction(sf, s.name) : null;
        if (fn) roots.push({ node: fn, file: s.file });
        return;
      }
      const local = findFunction(index, name);
      if (local) roots.push({ node: local, file: INDEX_TS });
    };
    if (ts.isCallExpression(expr)) {
      const calleeName = ts.isIdentifier(expr.expression) ? expr.expression.text : "";
      let considered: ts.Expression[];
      if (calleeName === "handler") {
        considered = expr.arguments.length >= 1 ? [expr.arguments[0]] : [];
      } else if (calleeName === "txHandler") {
        considered = expr.arguments.length >= 2 ? [expr.arguments[1]] : [];
      } else {
        // Factory forms (previewSendHandler(previewSend), sendTransactionHandler(sendTransaction), …):
        // analyze the factory itself AND every identifier argument.
        considered = [...expr.arguments];
        if (calleeName) addIdentifier(calleeName);
      }
      for (const c of considered) {
        if (ts.isIdentifier(c)) addIdentifier(c.text);
        else if (ts.isArrowFunction(c) || ts.isFunctionExpression(c)) {
          roots.push({ node: c, file: INDEX_TS });
        }
      }
    } else if (ts.isIdentifier(expr)) {
      addIdentifier(expr.text);
    }
    return roots;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerTool" &&
      node.arguments.length >= 4 &&
      ts.isStringLiteral(node.arguments[1])
    ) {
      const name = node.arguments[1].text;
      const handlerExpr = node.arguments[3];
      const roots = rootsFromExpr(handlerExpr);
      let sinkPath: string[] | null = null;
      for (const r of roots) {
        const hit = reachesSinkFromNode(r.node, r.file, new Set<string>(), [name]);
        if (hit) {
          sinkPath = hit;
          break;
        }
      }
      results.push({ name, sinkReaching: sinkPath !== null, sinkPath });
    }
    ts.forEachChild(node, visit);
  };
  visit(index);
  return results;
}
