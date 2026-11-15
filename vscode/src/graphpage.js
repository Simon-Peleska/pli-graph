// Answers the Show Graph page's questions, and makes the coverage report, in
// a thread of its own, so seconds of SQL for a big graph never stall the editor.

import { userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { coverageReport, keywordsIn } from "./coverage.js";
import { Descriptions, LABELS, subjectKey } from "./descriptions.js";
import { Graph } from "./graph.js";
import { createIndexer, grammarsIn } from "./indexer.js";
import { generateJs } from "./tojs.js";

/**
 * @typedef {object} PageQuestion
 * @property {number} id
 * @property {"summary" | "overview" | "module" | "procedure" | "dependencies" | "dependencyList" | "flow" | "dataFlow" | "dataModel" | "transactions" | "dataUse" | "deadCode" | "messages" | "batchChain" | "hotspots" | "dataOwners" | "screenInput" | "columnPath" | "details" | "search" | "list" | "subjects" | "descriptions" | "pageDescriptions" | "describe" | "undescribe" | "coverage" | "generateJs"} what
 * @property {any[]} args
 */
/** @typedef {{ id: number, result: unknown, ms: number } | { id: number, error: string }} PageAnswer */
/** @typedef {{ progress: string }} PageProgress what generateJs is doing, before its answer */

const port = /** @type {import("node:worker_threads").MessagePort} */ (parentPort);
const db = new DatabaseSync(workerData.graph);
db.exec("PRAGMA busy_timeout = 2000");
const graph = new Graph(db, workerData.root);
const descriptions = new Descriptions(workerData.root);
/** @type {ReturnType<typeof createIndexer> | undefined} */
let indexer;

// The person at the editor writes the page's descriptions.
function author() {
  try {
    return userInfo().username;
  } catch {
    return "?";
  }
}

/** @type {Record<PageQuestion["what"], (...args: any[]) => unknown>} */
const answers = {
  summary: () => graph.pageSummary(),
  overview: (folder, isolated) => graph.pageOverview(folder, isolated),
  module: (path) => graph.pageModule(path),
  procedure: (id, depth, direction) => graph.pageProcedure(id, depth, direction),
  dependencies: (path, direction) => graph.pageDependencies(path, direction),
  dependencyList: (id, direction) => graph.pageDependencyList(id, direction),
  flow: (id, depth) => graph.pageFlow(id, depth),
  dataFlow: (id) => graph.pageDataFlow(id),
  dataModel: (path, depth) => graph.pageDataModel(path, depth),
  transactions: (name) => graph.transactionCrud(name),
  dataUse: (id) => graph.procedureCrud(id),
  deadCode: (path) => graph.deadCode(path),
  messages: (path) => graph.messages(path),
  batchChain: (path) => graph.batchChain(path),
  hotspots: (path) => graph.hotspots(path),
  dataOwners: (path) => graph.dataOwners(path),
  screenInput: (name) => graph.screenInput(name),
  columnPath: (/** @type {string} */ id) => graph.columnPath(id.slice(0, id.lastIndexOf(".")), id.slice(id.lastIndexOf(".") + 1)),
  details: (id) => graph.pageDetails(id),
  search: (query) => graph.pageSearch(query),
  list: (tab, filter) => graph.pageList(tab, filter),
  coverage: () => coverageReport(db, workerData.root, keywordsIn(workerData.grammars)),
  subjects: (query) => {
    const counts = new Map();
    for (const d of descriptions.read().descriptions) counts.set(d.subject.toUpperCase(), (counts.get(d.subject.toUpperCase()) ?? 0) + 1);
    return graph.subjects(query).map((s) => ({ ...s, descriptions: counts.get(s.key.toUpperCase()) ?? 0 }));
  },
  // One subject's descriptions, or with no key all of them.
  descriptions: (/** @type {string} */ key) => {
    const { descriptions: all, problems } = descriptions.read();
    if (!key) return { subject: null, descriptions: all, problems, labels: LABELS };
    const wanted = key.toUpperCase();
    return { subject: graph.subject(key) ?? null, descriptions: all.filter((d) => d.subject.toUpperCase() === wanted), problems, labels: LABELS };
  },
  pageDescriptions: (id) => {
    const key = graph.subjectOfPage(id);
    return { key: key ?? null, descriptions: key ? descriptions.of(key) : [] };
  },
  describe: (key, label, text, id) =>
    id ? descriptions.update(id, { label, text, author: author() }) : descriptions.add({ subject: subjectKey(graph, key), label, text, author: author() }),
  undescribe: (id) => descriptions.remove(id),
  generateJs: async (outDir) => {
    indexer ??= createIndexer(grammarsIn(workerData.grammars));
    /** @param {string} text */
    const progress = (text) => port.postMessage(/** @type {PageProgress} */ ({ progress: text }));
    return generateJs(db, workerData.root, await indexer, outDir, { templates: join(workerData.grammars, "jsruntime"), progress });
  },
};

port.on("message", async (/** @type {PageQuestion} */ question) => {
  const started = performance.now();
  /** @type {PageAnswer} */
  let answer;
  try {
    const respond = answers[question.what];
    if (!respond) throw new Error(`no question ${question.what}`);
    answer = { id: question.id, result: await respond(...question.args), ms: Math.round(performance.now() - started) };
  } catch (error) {
    answer = { id: question.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  port.postMessage(answer);
});
