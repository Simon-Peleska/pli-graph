// What people and agents say about the graph's subjects (SPEC §3.1), each
// description labelled with where it came from. Kept in the workspace as
// JSON Lines, one description per line sorted by subject, so it goes through
// git with the code and survives every rebuild of the graph. The page worker
// and the MCP server both write it, so it is read again on every call.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DESCRIPTIONS_FILE = "pli-graph.descriptions.jsonl";
export const LABELS = ["expert", "programmer", "ai agent", "docs"];

/**
 * @typedef {object} Description
 * @property {string} id
 * @property {string} subject the subject's key: procedure:SRC/KDP00001#PRUEFE
 * @property {string} label one of LABELS
 * @property {string} text
 * @property {string} author who wrote or last changed it
 * @property {string} at when, ISO 8601
 */

/**
 * The key a description may be given to: the graph's spelling of `key`.
 * @param {import("./graph.js").Graph} graph
 * @param {string} key
 */
export function subjectKey(graph, key) {
  const subject = graph.subject(key);
  if (!subject?.places.length) throw new Error(`[PLG094E] ${key} is no subject in the graph; find its key with a subject search, like procedure:SRC/KDP00001#PRUEFE`);
  return subject.key;
}

export class Descriptions {
  /** @param {string} root the workspace folder */
  constructor(root) {
    this.file = join(root, DESCRIPTIONS_FILE);
  }

  /**
   * Every description, and a problem for each line that is none (a merge
   * conflict, a hand edit gone wrong).
   * @returns {{ descriptions: Description[], problems: string[] }}
   */
  read() {
    let text = "";
    try {
      text = readFileSync(this.file, "utf-8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw new Error(`[PLG096E] Reading ${this.file} failed: ${/** @type {Error} */ (error).message}`);
    }
    /** @type {Description[]} */
    const descriptions = [];
    /** @type {string[]} */
    const problems = [];
    for (const [i, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {}
      const fields = ["id", "subject", "label", "text", "author", "at"];
      if (value && typeof value === "object" && fields.every((field) => typeof value[field] === "string")) descriptions.push(value);
      else problems.push(`[PLG090W] Line ${i + 1} of ${DESCRIPTIONS_FILE} is no description: ${line.slice(0, 120)}`);
    }
    return { descriptions, problems };
  }

  /** @param {string} subject @returns {Description[]} */
  of(subject) {
    const wanted = subject.toUpperCase();
    return this.read().descriptions.filter((d) => d.subject.toUpperCase() === wanted);
  }

  /**
   * @param {{ subject: string, label: string, text: string, author: string }} description
   * @returns {Description}
   */
  add({ subject, label, text, author }) {
    return this.change((descriptions) => {
      const ids = new Set(descriptions.map((d) => d.id));
      let id = randomUUID().slice(0, 8);
      while (ids.has(id)) id = randomUUID().slice(0, 8);
      const added = { id, subject, ...checked(label, text), author, at: new Date().toISOString() };
      descriptions.push(added);
      return added;
    });
  }

  /**
   * @param {string} id
   * @param {{ label: string, text: string, author: string }} change
   * @returns {Description}
   */
  update(id, { label, text, author }) {
    return this.change((descriptions) => {
      const found = existing(descriptions, id);
      Object.assign(found, checked(label, text), { author, at: new Date().toISOString() });
      return found;
    });
  }

  /** @param {string} id @returns {Description} */
  remove(id) {
    return this.change((descriptions) => {
      const found = existing(descriptions, id);
      descriptions.splice(descriptions.indexOf(found), 1);
      return found;
    });
  }

  /**
   * Reads the file, changes the list and writes it back whole, sorted, through
   * a temporary file so a reader never sees half of it.
   * @param {(descriptions: Description[]) => Description} edit
   */
  change(edit) {
    const { descriptions, problems } = this.read();
    // Writing back only what could be read would drop the rest.
    if (problems.length) throw new Error(`[PLG091E] Not saved: ${DESCRIPTIONS_FILE} has lines that are no description; fix them first. ${problems.join(" ")}`);
    const result = edit(descriptions);
    descriptions.sort((a, b) => compare(a.subject, b.subject) || compare(a.at, b.at) || compare(a.id, b.id));
    const text = descriptions.map(({ id, subject, label, text, author, at }) => `${JSON.stringify({ id, subject, label, text, author, at })}\n`).join("");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text);
      renameSync(temporary, this.file);
    } catch (error) {
      throw new Error(`[PLG097E] Writing ${this.file} failed: ${/** @type {Error} */ (error).message}`);
    }
    return result;
  }
}

/** @param {string} a @param {string} b */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string} label @param {string} text */
function checked(label, text) {
  if (!LABELS.includes(label)) throw new Error(`[PLG092E] The label ${JSON.stringify(label)} is none of ${LABELS.join(", ")}`);
  if (!text?.trim()) throw new Error(`[PLG093E] A description needs a text`);
  return { label, text: text.trim() };
}

/** @param {Description[]} descriptions @param {string} id */
function existing(descriptions, id) {
  const found = descriptions.find((d) => d.id === id);
  if (!found) throw new Error(`[PLG095E] No description has the id ${id}`);
  return found;
}
