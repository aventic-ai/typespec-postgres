// Layer ordering lint: the layer is a decorator fact, not a file fact.
// Two rules, both position-based: impl-layer decorators are applied only as
// augment statements (the ledger form), and within any file every impl-layer
// statement follows every contract-layer statement — contract reads first,
// impl comes last. A pure-impl overflow file satisfies the ordering
// vacuously. Foreign decorators (@doc, …) are exempt: the vocabulary is
// exactly what lib/index.js implements.
import { getSourceLocation } from "@typespec/compiler";
import { $decorators } from "../lib/index.js";
import { decoratorLayer } from "../lib/layers.mjs";

const VOCAB = new Set(Object.keys($decorators[""]));

// --- Public Functions ---

/** Layering violations for a compiled program; [] when clean. */
export function lintLayers(program) {
  const problems = [];
  const files = new Map(); // path -> [{pos, line, layer, label}]
  const glob = program.getGlobalNamespaceType();
  for (const [name, ns] of glob.namespaces) {
    if (name === "TypeSpec") continue;
    collectNamespace(ns, name, files, problems);
  }
  for (const items of files.values()) orderingProblem(items, problems);
  return problems;
}

// --- Internal Functions ---

function collectNamespace(ns, nsName, files, problems) {
  for (const [, model] of ns.models) {
    declaration(model, `model ${model.name}`, "contract", files);
    applications(model, files, problems);
    for (const [, prop] of model.properties) applications(prop, files, problems);
  }
  for (const [, op] of ns.operations) {
    // cron jobs have no interface presence: the whole op is impl, and its
    // @schedule/@command ride it inline legally
    const layer = nsName === "cron" ? "impl" : "contract";
    declaration(op, `op ${op.name}`, layer, files);
    applications(op, files, problems, layer);
    for (const [, param] of op.parameters.properties) applications(param, files, problems, layer);
  }
  for (const [, en] of ns.enums) {
    declaration(en, `enum ${en.name}`, "contract", files);
    applications(en, files, problems);
  }
  for (const [, sc] of ns.scalars) {
    declaration(sc, `scalar ${sc.name}`, "contract", files);
    applications(sc, files, problems);
  }
  for (const [name, child] of ns.namespaces) collectNamespace(child, name, files, problems);
}

function applications(type, files, problems, declLayer = "contract") {
  for (const d of type.decorators ?? []) {
    const name = d.definition?.name?.replace(/^@/, "");
    if (!name || !VOCAB.has(name)) continue;
    const loc = getSourceLocation(d.node ?? type.node);
    if (!loc || isLibrary(loc.file.path)) continue;
    const layer = decoratorLayer(name);
    // augment statements carry targetType (the augmented reference); inline
    // decorator expressions do not — structural, SyntaxKind isn't exported
    const augment = !!d.node && "targetType" in d.node;
    if (layer === "impl" && !augment && declLayer !== "impl") {
      // inline impl decorators ride a declaration; the ledger form is the law
      problems.push(problem(loc, `impl-layer @${name} must be an augment statement (@@${name}) below the contract`));
      continue;
    }
    // inline contract decorators share their declaration's span; only
    // augments participate in ordering as their own statements
    if (augment) item(files, loc, layer, `@@${name}`);
  }
}

function declaration(type, label, layer, files) {
  const loc = getSourceLocation(type);
  if (!loc || isLibrary(loc.file.path)) return;
  item(files, loc, layer, label);
}

function orderingProblem(items, problems) {
  items.sort((a, b) => a.pos - b.pos);
  let firstImpl = null;
  for (const it of items) {
    if (it.layer === "impl") firstImpl ??= it;
    else if (firstImpl) {
      // one violation per file: the first contract statement out of place
      problems.push(problem(it.loc, `contract-layer ${it.label} follows ${firstImpl.label} — impl comes last in a file`));
      return;
    }
  }
}

function item(files, loc, layer, label) {
  if (!files.has(loc.file.path)) files.set(loc.file.path, []);
  files.get(loc.file.path).push({ pos: loc.pos, loc, layer, label });
}

function problem(loc, message) {
  const { line } = loc.file.getLineAndCharacterOfPosition(loc.pos);
  return { message, file: loc.file.path, line: line + 1 };
}

// the pg library's own declarations (scalars in `public`) are not spec files
const LIB_DIR = new URL("../lib/", import.meta.url).pathname;
const isLibrary = (path) => path.startsWith(LIB_DIR) || path.includes("node_modules");
