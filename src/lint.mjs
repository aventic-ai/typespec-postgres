// Section ordering lint: a spec file reads data, then security, then impl —
// three SECTIONS, still two LAYERS (severity is untouched; the security
// section gates). Two position-based rules: security- and impl-rank
// decorators are applied only as augment statements (the ledger form —
// with two ratified exceptions: cron ops carry @schedule/@command inline
// because the whole op is impl, and view security flags stay inline on
// their headers because the dangerous kind announces itself), and within
// any file no statement's section may precede one of a higher rank already
// seen. A pure single-section file satisfies the ordering vacuously.
// Foreign decorators (@doc, …) are exempt: the vocabulary is exactly what
// lib/index.js implements.
import { getSourceLocation } from "@typespec/compiler";
import { $decorators } from "../lib/index.js";
import { sectionRank } from "../lib/layers.mjs";

const VOCAB = new Set(Object.keys($decorators[""]));
const SECTION = ["data", "security", "impl"];
const INLINE_OK = new Set(["security_invoker", "security_definer"]);

// --- Public Functions ---

/** Section violations for a compiled program; [] when clean. */
export function lintLayers(program) {
  const problems = [];
  const files = new Map(); // path -> [{pos, loc, rank, label}]
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
    declaration(model, `model ${model.name}`, 0, files);
    applications(model, files, problems);
    ownLineProblem(model, problems);
    for (const [, prop] of model.properties) applications(prop, files, problems);
  }
  for (const [, op] of ns.operations) {
    // cron jobs have no interface presence: the whole op is impl, and its
    // @schedule/@command ride it inline legally
    const rank = nsName === "cron" ? 2 : 0;
    declaration(op, `op ${op.name}`, rank, files);
    applications(op, files, problems, rank);
    for (const [, param] of op.parameters.properties) applications(param, files, problems, rank);
  }
  for (const [, en] of ns.enums) {
    declaration(en, `enum ${en.name}`, 0, files);
    applications(en, files, problems);
  }
  for (const [, sc] of ns.scalars) {
    declaration(sc, `scalar ${sc.name}`, 0, files);
    applications(sc, files, problems);
  }
  for (const [name, child] of ns.namespaces) collectNamespace(child, name, files, problems);
}

function applications(type, files, problems, declRank = 0) {
  for (const d of type.decorators ?? []) {
    const name = d.definition?.name?.replace(/^@/, "");
    if (!name || !VOCAB.has(name)) continue;
    const loc = getSourceLocation(d.node ?? type.node);
    if (!loc || isLibrary(loc.file.path)) continue;
    const rank = sectionRank(name);
    // augment statements carry targetType (the augmented reference); inline
    // decorator expressions do not — structural, SyntaxKind isn't exported
    const augment = !!d.node && "targetType" in d.node;
    if (rank > 0 && !augment && declRank !== 2 && !INLINE_OK.has(name)) {
      problems.push(problem(loc, `${SECTION[rank]}-section @${name} must be an augment statement (@@${name}) in its section`));
      continue;
    }
    // inline decorators share their declaration's span; only augments
    // participate in ordering as their own statements
    if (augment) item(files, loc, rank, `@@${name}`);
  }
}

// A model — header and body — reads as a list of facts: no inline decorator
// shares its declaration's line or another decorator's line, so property
// lines stay bare `name: type;` with their facts stacked above. Applies to
// every decorator, foreign included — formatting is file discipline, not
// vocabulary — but never double-flags one already reported as
// augment-required. Op parameters are exempt: signatures read as parameter
// lists.
function ownLineProblem(model, problems) {
  if (ownLineViolation(model, `model ${model.name}`, problems)) return;
  for (const [, prop] of model.properties) {
    if (ownLineViolation(prop, `${model.name}.${prop.name}`, problems)) return; // one per model
  }
}

function ownLineViolation(type, label, problems) {
  const idLoc = getSourceLocation(type.node?.id ?? type.node);
  if (!idLoc || isLibrary(idLoc.file.path)) return false;
  const seen = new Set([idLoc.file.getLineAndCharacterOfPosition(idLoc.pos).line]);
  for (const d of type.decorators ?? []) {
    if (!!d.node && "targetType" in d.node) continue; // augments live in sections
    const name = d.definition?.name?.replace(/^@/, "") ?? "?";
    if (VOCAB.has(name) && sectionRank(name) > 0 && !INLINE_OK.has(name)) continue; // flagged as augment-required
    const loc = getSourceLocation(d.node);
    if (!loc) continue;
    const line = loc.file.getLineAndCharacterOfPosition(loc.pos).line;
    if (seen.has(line)) {
      problems.push(problem(loc, `@${name} on ${label} takes its own line`));
      return true;
    }
    seen.add(line);
  }
  return false;
}

function declaration(type, label, rank, files) {
  const loc = getSourceLocation(type);
  if (!loc || isLibrary(loc.file.path)) return;
  item(files, loc, rank, label);
}

function orderingProblem(items, problems) {
  items.sort((a, b) => a.pos - b.pos);
  let highest = null;
  for (const it of items) {
    if (!highest || it.rank >= highest.rank) {
      if (!highest || it.rank > highest.rank) highest = it;
    } else {
      // one violation per file: the first statement out of section order
      problems.push(problem(it.loc,
        `${SECTION[it.rank]}-section ${it.label} follows ${SECTION[highest.rank]}-section ${highest.label} — sections order data, security, impl`));
      return;
    }
  }
}

function item(files, loc, rank, label) {
  if (!files.has(loc.file.path)) files.set(loc.file.path, []);
  files.get(loc.file.path).push({ pos: loc.pos, loc, rank, label });
}

function problem(loc, message) {
  const { line } = loc.file.getLineAndCharacterOfPosition(loc.pos);
  return { message, file: loc.file.path, line: line + 1 };
}

// the pg library's own declarations (scalars in `public`) are not spec files
const LIB_DIR = new URL("../lib/", import.meta.url).pathname;
const isLibrary = (path) => path.startsWith(LIB_DIR) || path.includes("node_modules");
