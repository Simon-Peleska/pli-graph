// Descriptions of the graph's subjects, on test/facts: finding a subject by
// name and key, the store in the workspace and the MCP tools writing it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DESCRIPTIONS_FILE, Descriptions, subjectKey } from "../src/descriptions.js";
import { Graph } from "../src/graph.js";
import { openGraph, sync } from "../src/indexer.js";
import { languageOf } from "../src/source.js";
import { indexer } from "./indexed.js";

const facts = join(import.meta.dirname, "facts");
const graphFile = join(mkdtempSync(join(tmpdir(), "pli-graph-")), "graph.sqlite");
const db = openGraph(graphFile);
await sync(db, facts, indexer);
const graph = new Graph(db, facts);

/** @param {string} key */
const places = (key) => graph.subject(key)?.places.map((p) => `${p.path}:${p.line}`);

test("a key of every kind finds its places, without case", () => {
  assert.deepEqual(places("program:kdp00001"), ["SRC/KDP00001:1"]);
  assert.deepEqual(places("procedure:src/kdp00001#pruefen"), ["SRC/KDP00001:15"]);
  assert.deepEqual(places("field:INCLUDE/KDC00001#KUNDE_SEG"), ["INCLUDE/KDC00001:2"]);
  assert.deepEqual(places("job:KDJOB01"), ["JCL/KDJOB01:1"]);
  assert.deepEqual(places("step:KDJOB01.PRUEF"), ["JCL/KDJOB01:2"]);
  assert.deepEqual(places("dataset:PROD.KD.AUSZUG"), ["JCL/KDJOB01:5", "JCL/KDJOB02:3"]);
  assert.deepEqual(places("table:PROD.KUNDE"), ["INCLUDE/KDT00001:1"]);
  assert.deepEqual(places("column:PROD.KUNDE.KDNR"), ["INCLUDE/KDT00001:2"]);
  assert.deepEqual(places("psb:KDPSB01"), ["IMS/KDPSB01:8"]);
  assert.deepEqual(places("dbd:KDDBD01"), ["IMS/KDDBD01:1"]);
  assert.deepEqual(places("segment:KDDBD01.KUNDE"), ["IMS/KDDBD01:3"]);
  assert.deepEqual(places("transaction:KD01"), ["IMS/KDSYSDEF:5"]);
  assert.deepEqual(places("screen:KDF001"), ["MFS/KDF00001:1"]);
  assert.deepEqual(places("screen-field:KDF001.KDNR"), ["MFS/KDF00001:7"]);
  assert.deepEqual(places("file:IMS/KDDBD01"), ["IMS/KDDBD01:1"]);
  assert.deepEqual(places("member:KDDRUCK"), ["IMS/KDDRUCK:1", "SRC/KDDRUCK:1"]);
  assert.equal(graph.subject("procedure:SRC/kdp00001#pruefen")?.key, "procedure:SRC/KDP00001#PRUEFEN");
});

test("an unknown subject has no places and an unknown kind is none", () => {
  assert.deepEqual(places("table:NOPE.X"), []);
  assert.equal(graph.subject("term:Kunde"), undefined);
  assert.equal(graph.subject("procedure:"), undefined);
  assert.throws(() => subjectKey(graph, "table:NOPE.X"), /\[PLG094E\]/);
});

test("a subject is found by the start of its name, the exact name first", () => {
  const found = graph.subjects("kdnr").map((s) => s.key);
  assert.ok(found.includes("column:PROD.KUNDE.KDNR"), found.join(" "));
  assert.ok(found.includes("screen-field:KDF001.KDNR"), found.join(" "));
  assert.deepEqual(graph.subjects("pruefen").map((s) => s.key)[0], "procedure:SRC/KDP00001#PRUEFEN");
  const job = graph.subjects("KDJOB01").map((s) => s.key);
  assert.deepEqual([job[0], job.includes("step:KDJOB01.PRUEF")], ["job:KDJOB01", true]);
  assert.equal(graph.subjects("K", 5).length, 5);
});

test("a page's procedure, program or file is a subject", () => {
  assert.equal(graph.subjectOfPage("SRC/KDP00001:PRUEFEN:15"), "procedure:SRC/KDP00001#PRUEFEN");
  assert.equal(graph.subjectOfPage("SRC/KDP00001"), "program:KDP00001");
  assert.equal(graph.subjectOfPage("INCLUDE/KDC00001"), "file:INCLUDE/KDC00001");
  assert.equal(graph.subjectOfPage("SRC/KDP00001:NIX:999"), undefined);
});

test("a key resolves however often its name is declared elsewhere", () => {
  const rc = db.prepare(`SELECT v.* FROM variables v WHERE v.name != '*' LIMIT 1`).get();
  assert.ok(rc);
  const { id, ...row } = /** @type {Record<string, any>} */ (rc);
  const insert = db.prepare(`INSERT INTO variables (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`);
  const path = /** @type {{ path: string }} */ (db.prepare(`SELECT path FROM files WHERE id = ?`).get(row.file)).path;
  const elsewhere = /** @type {{ id: number }} */ (db.prepare(`SELECT id FROM files WHERE id != ? LIMIT 1`).get(row.file)).id;
  db.exec("SAVEPOINT many");
  try {
    // Declared last, after 1500 others of its name, so it sorts behind them.
    for (let line = 100_000; line < 101_500; line++) insert.run(...Object.values({ ...row, file: elsewhere, line }));
    insert.run(...Object.values({ ...row, qualified: `LAST.${row.name}`, line: 200_000 }));
    assert.deepEqual(places(`field:${path}#LAST.${row.name}`), [`${path}:200000`]);
  } finally {
    db.exec("ROLLBACK TO many; RELEASE many");
  }
});

test("an undeclared table or column used in SQL is placed at one real use", () => {
  const { id, ...row } = /** @type {Record<string, any>} */ (db.prepare(`SELECT * FROM sql_columns LIMIT 1`).get());
  const files = /** @type {{ id: number, path: string }[]} */ (db.prepare(`SELECT id, path FROM files ORDER BY path LIMIT 2`).all());
  const insert = db.prepare(`INSERT INTO sql_columns (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`);
  db.exec("SAVEPOINT used");
  try {
    // Used late in the first file and early in the second: two min()s would mix them into a place that is no use.
    insert.run(...Object.values({ ...row, file: files[0].id, line: 50, schema: null, table_name: "NODDL", column_name: "NOCOL" }));
    insert.run(...Object.values({ ...row, file: files[1].id, line: 3, schema: null, table_name: "NODDL", column_name: "NOCOL" }));
    assert.deepEqual(places("table:NODDL"), [`${files[1].path}:3`]);
    assert.deepEqual(places("column:NODDL.NOCOL"), [`${files[1].path}:3`]);
  } finally {
    db.exec("ROLLBACK TO used; RELEASE used");
  }
});

test("the page worker saves, lists and deletes descriptions", async () => {
  const { Worker } = await import("node:worker_threads");
  const root = mkdtempSync(join(tmpdir(), "pli-descriptions-"));
  const worker = new Worker(join(import.meta.dirname, "..", "src", "graphpage.js"), { workerData: { graph: graphFile, root } });
  let asked = 0;
  /** @param {string} what @param {...unknown} args @returns {Promise<any>} */
  const ask = (what, ...args) =>
    new Promise((resolve) => {
      const id = ++asked;
      worker.on("message", (answer) => answer.id === id && resolve(answer));
      worker.postMessage({ id, what, args });
    });
  try {
    const added = (await ask("describe", "procedure:src/kdp00001#pruefen", "expert", "Prüft den Kunden.", null)).result;
    assert.equal(added.subject, "procedure:SRC/KDP00001#PRUEFEN");
    const changed = (await ask("describe", added.subject, "docs", "From the handbook.", added.id)).result;
    assert.deepEqual([changed.id, changed.label], [added.id, "docs"]);
    const page = (await ask("pageDescriptions", "SRC/KDP00001:PRUEFEN:15")).result;
    assert.deepEqual([page.key, page.descriptions.map((/** @type {any} */ d) => d.text)], [added.subject, ["From the handbook."]]);
    const found = (await ask("subjects", "pruefen")).result;
    assert.equal(found.find((/** @type {any} */ s) => s.key === added.subject)?.descriptions, 1);
    await ask("undescribe", added.id);
    assert.deepEqual((await ask("descriptions", added.subject)).result.descriptions, []);
    assert.match((await ask("describe", "table:NOPE.X", "expert", "x", null)).error, /\[PLG094E\]/);
  } finally {
    await worker.terminate();
  }
});

test("descriptions are kept sorted by subject in the workspace and changed by id", () => {
  const root = mkdtempSync(join(tmpdir(), "pli-descriptions-"));
  const store = new Descriptions(root);
  assert.deepEqual(store.read(), { descriptions: [], problems: [] });
  const later = store.add({ subject: "table:PROD.KUNDE", label: "expert", text: " Die Kunden. ", author: "anna" });
  const first = store.add({ subject: "procedure:SRC/KDP00001#PRUEFEN", label: "ai agent", text: "Checks the customer.", author: "copilot" });
  assert.equal(later.text, "Die Kunden.");
  const lines = readFileSync(join(root, DESCRIPTIONS_FILE), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((d) => d.id), [first.id, later.id]);
  assert.deepEqual(Object.keys(lines[0]), ["id", "subject", "label", "text", "author", "at"]);

  store.update(later.id, { label: "docs", text: "Customers, from the handbook.", author: "bert" });
  assert.deepEqual(store.of("TABLE:prod.kunde").map((d) => [d.label, d.text, d.author]), [["docs", "Customers, from the handbook.", "bert"]]);
  store.remove(first.id);
  assert.deepEqual(store.read().descriptions.map((d) => d.id), [later.id]);

  assert.throws(() => store.add({ subject: "table:PROD.KUNDE", label: "guess", text: "x", author: "a" }), /\[PLG092E\]/);
  assert.throws(() => store.add({ subject: "table:PROD.KUNDE", label: "expert", text: "  ", author: "a" }), /\[PLG093E\]/);
  assert.throws(() => store.remove("nope"), /\[PLG095E\]/);
});

test("a line that is no description is reported and stops every change", () => {
  const root = mkdtempSync(join(tmpdir(), "pli-descriptions-"));
  const good = `{"id":"a1","subject":"job:KDJOB01","label":"expert","text":"Loads.","author":"anna","at":"2026-01-01T00:00:00.000Z"}`;
  writeFileSync(join(root, DESCRIPTIONS_FILE), `${good}\n<<<<<<< HEAD\n`);
  const store = new Descriptions(root);
  const { descriptions, problems } = store.read();
  assert.deepEqual(descriptions.map((d) => d.id), ["a1"]);
  assert.match(problems[0], /^\[PLG090W\] Line 2 /);
  assert.throws(() => store.add({ subject: "job:KDJOB01", label: "expert", text: "x", author: "a" }), /\[PLG091E\]/);
  assert.equal(readFileSync(join(root, DESCRIPTIONS_FILE), "utf-8"), `${good}\n<<<<<<< HEAD\n`);
});

test("the indexer leaves the descriptions file alone", () => {
  assert.equal(languageOf(DESCRIPTIONS_FILE), undefined);
});

test("an agent finds subjects, describes them and reads the descriptions over MCP", () => {
  const root = mkdtempSync(join(tmpdir(), "pli-descriptions-"));
  const requests = [
    { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "copilot" } } },
    { method: "tools/call", params: { name: "subjects", arguments: { name: "pruefen" } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "procedure:src/kdp00001#pruefen", text: "Checks the customer number." } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "column:PROD.KUNDE.KDNR", text: "Die Kundennummer.", label: "expert" } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "procedure:SRC/NIX#NIX", text: "x" } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "column:PROD.KUNDE.KDNR", text: "x", label: "guess" } } },
    { method: "tools/call", params: { name: "descriptions", arguments: { subject: "PROCEDURE:SRC/KDP00001#PRUEFEN" } } },
    { method: "tools/call", params: { name: "descriptions", arguments: {} } },
  ];
  const input = requests.map((request, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...request })).join("\n");
  // The graph is facts', the workspace a fresh folder, so the fixture stays untouched.
  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/mcp.js"), graphFile, root], { input, stdio: ["pipe", "pipe", "ignore"] });
  const [, subjects, saved, , unknown, badLabel, one, all] = output.toString().trim().split("\n").map((line) => JSON.parse(line).result);
  assert.match(subjects.content[0].text, /^procedure:SRC\/KDP00001#PRUEFEN: SRC\/KDP00001:15$/m);
  assert.match(saved.content[0].text, /^Saved as \w{8} for procedure:SRC\/KDP00001#PRUEFEN\.$/);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /\[PLG094E\]/);
  assert.match(badLabel.content[0].text, /\[PLG092E\]/);
  assert.match(one.content[0].text, /^\[ai agent\] copilot, \d{4}-\d\d-\d\d, id \w{8}: Checks the customer number\.$/);
  assert.match(all.content[0].text, /^column:PROD\.KUNDE\.KDNR \[expert\] copilot, .*: Die Kundennummer\.\nprocedure:SRC\/KDP00001#PRUEFEN \[ai agent\]/);
});

test("an agent replaces its own descriptions over MCP but no expert's", () => {
  const root = mkdtempSync(join(tmpdir(), "pli-descriptions-"));
  const line = (/** @type {string} */ id, /** @type {string} */ label) => JSON.stringify({ id, subject: "job:KDJOB01", label, text: "old", author: "anna", at: "2026-01-01T00:00:00.000Z" });
  writeFileSync(join(root, DESCRIPTIONS_FILE), `${line("agent001", "ai agent")}\n${line("expert01", "expert")}\n`);
  const requests = [
    { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "copilot" } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "job:KDJOB01", text: "Loads the customers.", id: "agent001" } } },
    { method: "tools/call", params: { name: "describe", arguments: { subject: "job:KDJOB01", text: "Wrong.", id: "expert01" } } },
  ];
  const input = requests.map((request, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...request })).join("\n");
  const output = execFileSync(process.execPath, [join(import.meta.dirname, "../src/mcp.js"), graphFile, root], { input, stdio: ["pipe", "pipe", "ignore"] });
  const [, replaced, refused] = output.toString().trim().split("\n").map((line) => JSON.parse(line).result);
  assert.equal(replaced.content[0].text, "Saved as agent001 for job:KDJOB01.");
  assert.match(refused.content[0].text, /\[PLG099E\]/);
  const kept = new Descriptions(root).read().descriptions.map((d) => [d.id, d.text, d.author]);
  assert.deepEqual(kept, [["expert01", "old", "anna"], ["agent001", "Loads the customers.", "copilot"]]);
});
