// Layering lint: every pgspec decorator application must sit in a file of
// its layer, and declarations live in contract files (cron ops inverted —
// they are wholly impl). Foreign decorators (@doc, …) are exempt: the
// vocabulary is exactly what lib/index.js implements.
import { getSourceLocation } from "@typespec/compiler";
import { $decorators } from "../lib/index.js";
import { decoratorLayer, fileLayer } from "../lib/layers.mjs";

const VOCAB = new Set(Object.keys($decorators[""]));

// --- Public Functions ---

/** Layering violations for a compiled program; [] when clean. */
export function lintLayers(program) {
  const problems = [];
  const glob = program.getGlobalNamespaceType();
  for (const [name, ns] of glob.namespaces) {
    if (name === "TypeSpec") continue;
    lintNamespace(ns, name, problems);
  }
  return problems;
}

// --- Internal Functions ---

function lintNamespace(ns, nsName, problems) {
  // a misplaced declaration flags once; its decorators are consequences
  for (const [, model] of ns.models) {
    if (declaration(model, `model ${model.name}`, "contract", problems)) continue;
    applications(model, problems);
    for (const [, prop] of model.properties) applications(prop, problems);
  }
  for (const [, op] of ns.operations) {
    // cron jobs have no interface presence: the whole op is impl
    if (declaration(op, `op ${op.name}`, nsName === "cron" ? "impl" : "contract", problems)) continue;
    applications(op, problems);
    for (const [, param] of op.parameters.properties) applications(param, problems);
  }
  for (const [, en] of ns.enums) {
    if (declaration(en, `enum ${en.name}`, "contract", problems)) continue;
    applications(en, problems);
  }
  for (const [, sc] of ns.scalars) {
    if (declaration(sc, `scalar ${sc.name}`, "contract", problems)) continue;
    applications(sc, problems);
  }
  for (const [name, child] of ns.namespaces) lintNamespace(child, name, problems);
}

function applications(type, problems) {
  for (const d of type.decorators ?? []) {
    const name = d.definition?.name?.replace(/^@/, "");
    if (!name || !VOCAB.has(name)) continue;
    const layer = decoratorLayer(name);
    const loc = getSourceLocation(d.node ?? type.node);
    if (!loc || fileLayer(loc.file.path) === layer) continue;
    problems.push(problem(loc, `@${name} is ${layer}-layer but applied in a ${fileLayer(loc.file.path)} file`));
  }
}

function declaration(type, label, layer, problems) {
  const loc = getSourceLocation(type);
  if (!loc || isLibrary(loc.file.path) || fileLayer(loc.file.path) === layer) return false;
  problems.push(problem(loc, `${label} is a ${layer}-layer declaration but lives in a ${fileLayer(loc.file.path)} file`));
  return true;
}

function problem(loc, message) {
  const { line } = loc.file.getLineAndCharacterOfPosition(loc.pos);
  return { message, file: loc.file.path, line: line + 1 };
}

// the pg library's own declarations (scalars in `public`) are not spec files
const LIB_DIR = new URL("../lib/", import.meta.url).pathname;
const isLibrary = (path) => path.startsWith(LIB_DIR) || path.includes("node_modules");
