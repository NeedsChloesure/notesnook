/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { Parser } from "htmlparser2";
import Database from "./index.js";
import { RawDatabaseSchema } from "../database/index.js";
import {
  FilteredSelector,
  MAX_SQL_PARAMETERS
} from "../database/sql-collection.js";
import { rebuildSearchIndex } from "../database/fts.js";
import { logger } from "../logger.js";
import {
  HighlightedResult,
  Match,
  Note,
  SortOptions
} from "../types.js";
import { toChunks } from "../utils/array.js";
import { extractMatchingBlocks } from "../utils/html-parser.js";
import { VirtualizedGrouping } from "../utils/virtualized-grouping.js";
import {
  ArchivedFilter,
  QueryTokens,
  SerializedQuery,
  transformQuery
} from "../utils/query-transformer.js";
import { Kysely, ExpressionBuilder, sql } from "@streetwriters/kysely";

const MATCH_TAG_NAME = "nn-search-result";
const MATCH_TAG_REGEX = new RegExp(
  `<${MATCH_TAG_NAME}\\s+id="(.+?)">(.*?)<\\/${MATCH_TAG_NAME}>`,
  "gm"
);

type NoteMatchType = "title" | "content";

type NoteMatchRow = {
  id: string;
  type: NoteMatchType;
  rank: number;
};

type NoteMatch = {
  id: string;
  types: NoteMatchType[];
  rank: number;
};

type NormalizedTokens = ReturnType<typeof transformTokens>;

type SearchFieldPlan = {
  serialized?: SerializedQuery;
  tokens: NormalizedTokens;
  query?: string;
  requiresLocalScan: boolean;
};

type NoteSearchPlan = ReturnType<typeof transformQuery> & {
  titleField: SearchFieldPlan;
  contentField: SearchFieldPlan;
  hasTextQuery: boolean;
  hasFtsQuery: boolean;
  requiresLocalScan: boolean;
};

export async function searchNoteIds(
  db: Database,
  query: string,
  notes: FilteredSelector<Note>,
  sortOptions?: SortOptions
) {
  const plan = compileSearchPlan(query);
  const selector = await applySearchFilters(db, notes, plan);
  const matches = await collectMatches(db, selector, plan, sortOptions);
  return matches.ids;
}

export async function searchNotesWithHighlighting(
  db: Database,
  query: string,
  notes: FilteredSelector<Note>,
  sortOptions?: SortOptions
): Promise<VirtualizedGrouping<HighlightedResult>> {
  const plan = compileSearchPlan(query);
  const selector = await applySearchFilters(db, notes, plan);
  const matches = await collectMatches(db, selector, plan, sortOptions);
  const sqlDb = db.sql() as unknown as Kysely<RawDatabaseSchema>;

  return new VirtualizedGrouping<HighlightedResult>(
    matches.ids.length,
    20,
    async () => matches.ids,
    async (start, end) => {
      const chunk = matches.values.slice(start, end);
      const titleMatches = chunk
        .filter((result) => result.types.includes("title"))
        .map((result) => result.id);
      const contentMatches = chunk
        .filter((result) => result.types.includes("content"))
        .map((result) => result.id);

      const results: HighlightedResult[] = chunk.map((result) => ({
        id: result.id,
        title: [],
        type: "searchResult",
        content: [],
        rank: 0,
        dateCreated: 0,
        dateModified: 0
      }));

      const titles =
        titleMatches.length > 0 && !matches.isQueryless
          ? await sqlDb
              .selectFrom("notes")
              .where("id", "in", titleMatches)
              .select(["id", "title"])
              .execute()
          : [];

      for (const title of titles) {
        const { text: highlighted } = highlightQueries(
          title.title || "",
          plan.titleField.tokens.allTokens
        );
        const result = results.find((item) => item.id === title.id);
        if (!result) continue;
        result.title = splitHighlightedMatch(highlighted).flatMap((item) => item);
      }

      const contentRows =
        contentMatches.length > 0 && !matches.isQueryless
          ? await sqlDb
              .selectFrom("content")
              .where("noteId", "in", contentMatches)
              .select(["data", "noteId as id"])
              .$castTo<{ data: string; id: string }>()
              .execute()
          : [];

      for (const content of contentRows) {
        const result = results.find((item) => item.id === content.id);
        if (!result) continue;

        const highlighted = highlightHtmlContent(
          content.data,
          plan.contentField.tokens.allTokens
        );

        result.content = extractMatchingBlocks(
          highlighted,
          MATCH_TAG_NAME
        ).flatMap((block) => splitHighlightedMatch(block));

        if (result.content.length === 0) continue;
        result.rawContent = highlighted;
      }

      const missingTitles = results
        .filter(
          matches.isQueryless
            ? (result) => !result.title.length
            : (result) => !result.title.length && result.content.length > 0
        )
        .map((result) => result.id);

      if (missingTitles.length > 0) {
        const titles = await sqlDb
          .selectFrom("notes")
          .where("id", "in", missingTitles)
          .select(["id", "title"])
          .execute();

        for (const title of titles) {
          const result = results.find((item) => item.id === title.id);
          if (!result || !title.title) continue;
          result.title = stringToMatch(title.title);
        }
      }

      for (const result of results) {
        result.content.sort(
          (a, b) =>
            getMatchScore(b, plan.contentField.tokens.allTokens) -
            getMatchScore(a, plan.contentField.tokens.allTokens)
        );
      }

      return {
        ids: results.map((result) => result.id),
        items: results
      };
    },
    () =>
      new Map([
        [
          0,
          {
            index: 0,
            group: {
              id: "0",
              title: "",
              type: "header"
            }
          }
        ]
      ])
  );
}

export async function rebuildNoteSearchIndex(db: Database) {
  const sqlDb = db.sql() as unknown as Kysely<RawDatabaseSchema>;
  await rebuildSearchIndex(sqlDb);
}

function compileSearchPlan(query: string): NoteSearchPlan {
  const parsed = transformQuery(query);
  const titleField = compileFieldPlan(parsed.title);
  const contentField = compileFieldPlan(parsed.content);

  return {
    ...parsed,
    titleField,
    contentField,
    hasTextQuery: !!(parsed.title || parsed.content),
    hasFtsQuery: !!(titleField.query || contentField.query),
    requiresLocalScan:
      titleField.requiresLocalScan || contentField.requiresLocalScan
  };
}

function compileFieldPlan(serialized?: SerializedQuery): SearchFieldPlan {
  return {
    serialized,
    tokens: transformTokens(serialized?.tokens),
    query: serialized?.query,
    requiresLocalScan: requiresLocalScan(serialized)
  };
}

async function applySearchFilters(
  db: Database,
  notes: FilteredSelector<Note>,
  plan: NoteSearchPlan
) {
  if (plan.filters <= 0) return notes;

  const tagIds =
    typeof plan.tagged === "boolean"
    ? await db.tags.all.ids()
    : plan.tag?.length
    ? await db.tags.all.where((eb) => eb("tags.title", "in", plan.tag!)).ids()
    : [];
  const colorIds =
    typeof plan.colored === "boolean"
    ? await db.colors.all.ids()
    : plan.color?.length
    ? await db.colors.all
        .where((eb) => eb("colors.title", "in", plan.color!))
        .ids()
    : [];
  const notebookIds =
    typeof plan.in_notebook === "boolean" ? await db.notebooks.all.ids() : [];

  const defaultVault = await db.vaults.default();
  return notes.where((eb) => {
    const expressions = [];
    const tagsFilter = db.relations
      .from({ ids: tagIds, type: "tag" }, "note")
      .selector.filter.select("id");
    const colorsFilter = db.relations
      .from({ ids: colorIds, type: "color" }, "note")
      .selector.filter.select("id");

    if (typeof plan.tagged === "boolean") {
      expressions.push(
        eb("notes.id", plan.tagged ? "in" : "not in", tagsFilter)
      );
    } else if (tagIds.length > 0) {
      expressions.push(eb("notes.id", "in", tagsFilter));
    }

    if (typeof plan.colored === "boolean") {
      expressions.push(
        eb("notes.id", plan.colored ? "in" : "not in", colorsFilter)
      );
    } else if (colorIds.length > 0) {
      expressions.push(eb("notes.id", "in", colorsFilter));
    }

    if (typeof plan.in_notebook === "boolean") {
      expressions.push(
        eb(
          "notes.id",
          plan.in_notebook ? "in" : "not in",
          db.relations
            .from({ ids: notebookIds, type: "notebook" }, "note")
            .selector.filter.select("id")
        )
      );
    }

    if (typeof plan.locked === "boolean" && defaultVault) {
      const filter = db.relations
        .from(defaultVault, "note")
        .selector.filter.select("id");
      expressions.push(eb("notes.id", plan.locked ? "in" : "not in", filter));
    }

    if (plan.archived === false) {
      expressions.push(eb("notes.archived", "==", false));
    }
    if (plan.archived === "only") {
      expressions.push(eb("notes.archived", "==", true));
    }
    if (typeof plan.favorite === "boolean") {
      expressions.push(eb("notes.favorite", "==", plan.favorite));
    }
    if (typeof plan.pinned === "boolean") {
      expressions.push(eb("notes.pinned", "==", plan.pinned));
    }
    if (typeof plan.readonly === "boolean") {
      expressions.push(eb("notes.readonly", "==", plan.readonly));
    }
    if (typeof plan.created_after === "number") {
      expressions.push(eb("notes.dateCreated", ">", plan.created_after));
    }
    if (typeof plan.created_before === "number") {
      expressions.push(eb("notes.dateCreated", "<", plan.created_before));
    }
    if (typeof plan.edited_after === "number") {
      expressions.push(eb("notes.dateEdited", ">", plan.edited_after));
    }
    if (typeof plan.edited_before === "number") {
      expressions.push(eb("notes.dateEdited", "<", plan.edited_before));
    }

    return eb.and(expressions);
  });
}

export function shouldExpandArchivedSearch(
  archived: ArchivedFilter | undefined | null
) {
  return archived !== null && archived !== undefined;
}

async function collectMatches(
  db: Database,
  notes: FilteredSelector<Note>,
  plan: NoteSearchPlan,
  sortOptions?: SortOptions
) {
  const excludedIds = db.trash.cache.notes;
  const ftsResults = await queryFts(db, notes, plan, excludedIds);
  const localResults =
    plan.hasTextQuery &&
    (!plan.hasFtsQuery || plan.requiresLocalScan || ftsResults.length === 0)
      ? await queryLocalMatches(db, notes, plan)
      : [];

  let matches = mergeMatches(
    plan.hasTextQuery &&
      (!plan.hasFtsQuery || plan.requiresLocalScan || ftsResults.length === 0)
      ? localResults
      : ftsResults,
    ftsResults
  );

  const isQueryless = !plan.hasTextQuery && plan.filters > 0;
  if (isQueryless) {
    matches = {
      ids: await notes.ids(sortOptions),
      values: (await notes.ids(sortOptions)).map((id) => ({
        id,
        rank: 1,
        types: ["title"] as NoteMatchType[]
      }))
    };
  } else {
    matches = await sortMatches(notes, matches, sortOptions);
  }

  return {
    ...matches,
    isQueryless
  };
}

function mergeMatches(primary: NoteMatchRow[], supplemental: NoteMatchRow[]) {
  const map = new Map<string, NoteMatch>();

  for (const entry of [...primary, ...supplemental]) {
    const current = map.get(entry.id) || {
      id: entry.id,
      types: [],
      rank: 0
    };

    if (!current.types.includes(entry.type)) {
      current.types.push(entry.type);
    }
    current.rank += entry.rank || 0;
    map.set(entry.id, current);
  }

  const values = Array.from(map.values());
  return {
    ids: values.map((value) => value.id),
    values
  };
}

async function sortMatches(
  notes: FilteredSelector<Note>,
  matches: { ids: string[]; values: NoteMatch[] },
  sortOptions?: SortOptions
) {
  if (!sortOptions || sortOptions.sortBy === "relevance") {
    matches.values.sort(
      sortOptions?.sortDirection === "asc"
        ? (a, b) => b.rank - a.rank
        : (a, b) => a.rank - b.rank
    );
    matches.ids = matches.values.map((value) => value.id);
    return matches;
  }

  const sortedNoteIds = await notes.fields(["notes.id"]).items(
    matches.ids,
    sortOptions
  );
  notes.fields([]);
  const sorted = {
    ids: [] as string[],
    values: [] as NoteMatch[]
  };

  for (const { id } of sortedNoteIds) {
    const match = matches.values.find((value) => value.id === id);
    if (!match) continue;
    sorted.ids.push(id);
    sorted.values.push(match);
  }

  return sorted;
}

async function queryFts(
  db: Database,
  notes: FilteredSelector<Note>,
  plan: NoteSearchPlan,
  excludedIds: string[]
) {
  if (!plan.hasFtsQuery) return [];

  const sqlDb = db.sql() as unknown as Kysely<RawDatabaseSchema>;
  const query = buildFtsQuery(sqlDb, notes, plan, excludedIds);
  if (!query) return [];

  return (
    (await query
      .select(["id", "type", "rank"])
      .execute()
      .catch((error) => {
        logger.error(error, "Error while searching notes", { query: plan });
        return [];
      })) || []
  );
}

function buildFtsQuery(
  db:
    | Kysely<RawDatabaseSchema>
    | ExpressionBuilder<RawDatabaseSchema, never>,
  notes: FilteredSelector<Note>,
  plan: NoteSearchPlan,
  excludedIds: string[]
) {
  function buildTitleQuery(
    queryDb:
      | Kysely<RawDatabaseSchema>
      | ExpressionBuilder<RawDatabaseSchema, never>
  ) {
    return queryDb
      .selectFrom("notes_fts")
      .where("id", "in", notes.filter.select("id"))
      .$if(excludedIds.length > 0, (eb) => eb.where("id", "not in", excludedIds))
      .where("title", "match", plan.titleField.query!)
      .where("rank", "=", sql<number>`'bm25(1.0, 10.0)'`)
      .select(["id", "rank", sql<string>`'title'`.as("type")]);
  }

  function buildContentQuery(
    queryDb:
      | Kysely<RawDatabaseSchema>
      | ExpressionBuilder<RawDatabaseSchema, never>
  ) {
    return queryDb
      .selectFrom("content_fts")
      .where("noteId", "in", notes.filter.select("id"))
      .$if(excludedIds.length > 0, (eb) =>
        eb.where("noteId", "not in", excludedIds)
      )
      .where("data", "match", plan.contentField.query!)
      .where("rank", "=", sql<number>`'bm25(1.0, 1.0, 10.0)'`)
      .select(["noteId as id", "rank", sql<string>`'content'`.as("type")])
      .$castTo<NoteMatchRow>();
  }

  if (plan.titleField.query && plan.contentField.query) {
    return db.selectFrom((eb) =>
      buildTitleQuery(eb).unionAll((unionDb) => buildContentQuery(unionDb)).as("results")
    );
  }
  if (plan.titleField.query) {
    return db.selectFrom((eb) => buildTitleQuery(eb).as("results"));
  }
  if (plan.contentField.query) {
    return db.selectFrom((eb) => buildContentQuery(eb).as("results"));
  }
}

async function queryLocalMatches(
  db: Database,
  notes: FilteredSelector<Note>,
  plan: NoteSearchPlan
) {
  const candidateIds = await notes.ids();
  if (candidateIds.length === 0) return [];

  const matches: NoteMatchRow[] = [];
  const sqlDb = db.sql() as unknown as Kysely<RawDatabaseSchema>;

  if (plan.titleField.serialized) {
    const titles = await fetchTitles(sqlDb, candidateIds);
    for (const title of titles) {
      if (!matchesSerializedQuery(title.title || "", plan.titleField.serialized)) {
        continue;
      }
      matches.push({ id: title.id, type: "title", rank: 1 });
    }
  }

  if (plan.contentField.serialized) {
    const contentRows = await fetchContent(sqlDb, candidateIds);
    for (const content of contentRows) {
      if (
        !matchesSerializedQuery(
          htmlToSearchText(content.data || ""),
          plan.contentField.serialized
        )
      ) {
        continue;
      }
      matches.push({ id: content.id, type: "content", rank: 1 });
    }
  }

  return matches;
}

async function fetchTitles(
  db: Kysely<RawDatabaseSchema>,
  ids: string[]
) {
  const rows: Array<{ id: string; title: string | null }> = [];

  for (const chunk of toChunks(ids, MAX_SQL_PARAMETERS)) {
    rows.push(
      ...(
        await db
          .selectFrom("notes")
          .where("id", "in", chunk)
          .select(["id", "title"])
          .execute()
      )
    );
  }

  return rows;
}

async function fetchContent(
  db: Kysely<RawDatabaseSchema>,
  ids: string[]
) {
  const rows: Array<{ id: string; data: string | null }> = [];

  for (const chunk of toChunks(ids, MAX_SQL_PARAMETERS)) {
    rows.push(
      ...(
        await db
          .selectFrom("content")
          .where("noteId", "in", chunk)
          .where("deleted", "is not", true)
          .where((eb) =>
            eb.or([eb("locked", "!=", true), eb("locked", "is", null)])
          )
          .select(["noteId as id", "data"])
          .$castTo<{ id: string; data: string | null }>()
          .execute()
      )
    );
  }

  return rows;
}

function requiresLocalScan(serialized?: SerializedQuery) {
  if (!serialized) return false;

  for (const child of serialized.ast.children) {
    if (child.type !== "phrase") continue;
    for (const token of child.value) {
      if (normalizeToken(token).length < 3) return true;
    }
  }

  return false;
}

function matchesSerializedQuery(text: string, serialized: SerializedQuery) {
  const normalizedText = normalizeSearchText(text);
  const evaluationTokens: Array<boolean | "AND" | "OR" | "NOT"> = [];

  for (const child of serialized.ast.children) {
    if (child.type === "phrase") {
      evaluationTokens.push(
        child.value.every((token) => normalizedText.includes(normalizeToken(token)))
      );
      continue;
    }

    if (
      child.type === "NOT" &&
      typeof evaluationTokens[evaluationTokens.length - 1] === "boolean"
    ) {
      evaluationTokens.push("AND");
    }

    evaluationTokens.push(child.type);
  }

  return evaluateBooleanExpression(evaluationTokens);
}

function evaluateBooleanExpression(tokens: Array<boolean | "AND" | "OR" | "NOT">) {
  const output: Array<boolean | "AND" | "OR" | "NOT"> = [];
  const operators: Array<"AND" | "OR" | "NOT"> = [];
  const precedence = { OR: 1, AND: 2, NOT: 3 } as const;

  for (const token of tokens) {
    if (typeof token === "boolean") {
      output.push(token);
      continue;
    }

    while (operators.length > 0) {
      const last = operators[operators.length - 1];
      if (
        (token === "NOT" && precedence[last] > precedence[token]) ||
        (token !== "NOT" && precedence[last] >= precedence[token])
      ) {
        output.push(operators.pop()!);
        continue;
      }
      break;
    }

    operators.push(token);
  }

  while (operators.length > 0) {
    output.push(operators.pop()!);
  }

  const stack: boolean[] = [];
  for (const token of output) {
    if (typeof token === "boolean") {
      stack.push(token);
      continue;
    }

    if (token === "NOT") {
      const value = stack.pop();
      stack.push(!value);
      continue;
    }

    const right = stack.pop();
    const left = stack.pop();
    stack.push(token === "AND" ? !!left && !!right : !!left || !!right);
  }

  return stack[0] || false;
}

function splitToNearestWord(text: string, maxLength: number): [string, string] {
  if (text.length <= maxLength) return [text, ""];

  let splitIndex = text.lastIndexOf(" ", maxLength);
  if (splitIndex === -1) {
    splitIndex = maxLength;
  }

  return [text.substring(0, splitIndex), text.substring(splitIndex)];
}

function normalizeToken(token: string) {
  return normalizeSearchText(token.replace(/^"(.+)"$/g, "$1"));
}

function normalizeSearchText(text: string) {
  return removeDiacritics(text || "").toLowerCase();
}

function htmlToSearchText(html: string) {
  let text = "";
  const parser = new Parser(
    {
      ontext(data) {
        text += data;
      },
      onclosetag(name) {
        if (name === "br") {
          text += "\n";
          return;
        }

        if (!INLINE_TAGS.has(name)) {
          text += " ";
        }
      }
    },
    {
      lowerCaseTags: false,
      decodeEntities: true
    }
  );

  parser.end(html);
  return text.replace(/\s+/g, " ").trim();
}

function highlightQueries(
  text: string,
  queries: string[]
): { text: string; hasMatches: boolean } {
  if (!text || !queries.length) return { text, hasMatches: false };

  const patterns = queries
    .filter((query) => query.length > 0)
    .map((query) => query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (patterns.length === 0) return { text, hasMatches: false };

  try {
    const regex = new RegExp(patterns.join("|"), "gi");
    const normalizedText = removeDiacritics(text);
    const { result, hasMatches } = highlightRegexMatches(
      text,
      normalizedText,
      regex,
      0
    );
    return { text: result, hasMatches };
  } catch {
    return { text, hasMatches: false };
  }
}

function highlightHtmlContent(html: string, queries: string[]) {
  if (!html || !queries.length) return html;

  const patterns = queries
    .filter((query) => query && query.length > 0)
    .map((query) => query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!patterns.length) return html;

  const searchRegex = new RegExp(`(${patterns.join("|")})`, "gi");
  let result = "";
  let matchIdCounter = 0;

  interface ElementInfo {
    name: string;
    attributes: Record<string, string>;
    hasMatch: boolean;
    buffer: string;
  }

  const elementStack: ElementInfo[] = [];
  const parser = new Parser(
    {
      ontext(text) {
        const normalizedText = removeDiacritics(text);
        const highlighted = highlightRegexMatches(
          text,
          normalizedText,
          searchRegex,
          matchIdCounter
        );
        matchIdCounter = highlighted.nextId;

        if (highlighted.hasMatches) {
          elementStack.forEach((element) => (element.hasMatch = true));
        }

        if (elementStack.length > 0) {
          elementStack[elementStack.length - 1].buffer += highlighted.result;
        } else {
          result += highlighted.result;
        }
      },
      onopentag(name, attributes) {
        elementStack.push({
          name,
          attributes: { ...attributes },
          hasMatch: false,
          buffer: ""
        });
      },
      onclosetag() {
        const element = elementStack.pop();
        if (!element) return;

        let html = `<${element.name}`;
        for (const [key, value] of Object.entries(element.attributes)) {
          if (
            element.name === "li" &&
            key === "data-collapsed" &&
            element.hasMatch
          ) {
            continue;
          }

          if (
            element.name === "div" &&
            key === "class" &&
            value?.includes("callout") &&
            element.hasMatch
          ) {
            html += ` ${key}="callout"`;
            continue;
          }

          html += ` ${key}="${value}"`;
        }

        html += `>${element.buffer}</${element.name}>`;
        if (elementStack.length > 0) {
          elementStack[elementStack.length - 1].buffer += html;
        } else {
          result += html;
        }
      },
      onprocessinginstruction(_name, data) {
        if (elementStack.length > 0) {
          elementStack[elementStack.length - 1].buffer += `<${data}>`;
        } else {
          result += `<${data}>`;
        }
      }
    },
    {
      decodeEntities: false,
      xmlMode: false
    }
  );

  parser.write(html);
  parser.end();
  return result;
}

function transformTokens(tokens: QueryTokens | undefined) {
  if (!tokens) {
    return {
      andTokens: [],
      orTokens: [],
      notTokens: [],
      allTokens: []
    };
  }

  const andTokens = tokens.andTokens.map(normalizeToken);
  const orTokens = tokens.orTokens.map(normalizeToken);
  const notTokens = tokens.notTokens.map(normalizeToken);

  return {
    andTokens,
    orTokens,
    notTokens,
    allTokens: [...andTokens, ...orTokens]
  };
}

function createSearchResultTag(content: string, id: string) {
  return `<${MATCH_TAG_NAME} id="${id}">${content}</${MATCH_TAG_NAME}>`;
}

function highlightRegexMatches(
  text: string,
  normalizedText: string,
  regex: RegExp,
  startId: number
) {
  let matchIdCounter = startId;
  let hasMatches = false;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalizedText)) !== null) {
    hasMatches = true;
    result += text.slice(lastIndex, match.index);
    result += createSearchResultTag(
      text.slice(match.index, match.index + match[0].length),
      `match-${++matchIdCounter}`
    );
    lastIndex = match.index + match[0].length;
  }

  result += text.slice(lastIndex);
  return { result, hasMatches, nextId: matchIdCounter };
}

export function splitHighlightedMatch(text: string): Match[][] {
  const parts = text.split(MATCH_TAG_REGEX);
  const allMatches: Match[][] = [];
  let matches: Match[] = [];
  let totalLength = 0;

  for (let index = 0; index < parts.length - 1; index += 3) {
    const prefix = parts[index];
    const matchId = parts[index + 1];
    const match = parts[index + 2];
    let suffix = parts[index + 3];
    const matchLength = prefix.length + match.length + (suffix?.length || 0);

    if (totalLength > 120 && matches.length > 0) {
      matches[matches.length - 1].suffix += "...";
      allMatches.push(matches);
      matches = [];
      totalLength = 0;
    }

    if (suffix) {
      suffix = suffix.replace(/\s{2,}/gm, " ");
      const [nextSuffix, remaining] = splitToNearestWord(
        suffix,
        Math.max(suffix.length / 2, 60)
      );
      parts[index + 3] = remaining;
      suffix = nextSuffix;
    }

    matches.push({
      match,
      prefix: prefix.replace(/\s{2,}/gm, " ").trimStart(),
      suffix: suffix || "",
      id: matchId || undefined
    });

    totalLength += matchLength;
  }

  if (matches.length > 0) {
    matches[matches.length - 1].suffix += parts[parts.length - 1];
    allMatches.push(matches);
  }

  for (const matchGroup of allMatches) {
    const groupLength = matchGroup.reduce(
      (length, current) =>
        length + current.match.length + current.prefix.length + current.suffix.length,
      0
    );

    if (groupLength <= 200) continue;

    const start = matchGroup[0];
    const end = matchGroup[matchGroup.length - 1];
    const centered = centerMatch(
      start.prefix,
      end.suffix,
      groupLength - (start.prefix.length + end.suffix.length),
      {
        maxLength: 200
      }
    );

    start.prefix = centered.prefix || " ";
    end.suffix = centered.suffix || " ";
  }

  return allMatches;
}

interface CenterOptions {
  maxLength?: number;
  minContext?: number;
  ellipsis?: string;
  preferLeft?: boolean;
}

function centerMatch(
  prefix: string,
  suffix: string,
  matchLength: number,
  options: CenterOptions = {}
) {
  const {
    maxLength = 120,
    minContext = 20,
    ellipsis = "...",
    preferLeft = true
  } = options;

  if (!prefix && !suffix) return {};
  if (matchLength >= maxLength) return {};

  const availableSpace = maxLength - matchLength;
  let leftLength = Math.floor(availableSpace / 2);
  let rightLength = availableSpace - leftLength;

  if (preferLeft && availableSpace % 2 !== 0) {
    leftLength++;
    rightLength--;
  }

  if (leftLength < minContext && prefix.length > leftLength) {
    const diff = Math.min(rightLength - minContext, minContext - leftLength);
    if (diff > 0) {
      leftLength += diff;
      rightLength -= diff;
    }
  } else if (rightLength < minContext && suffix.length > rightLength) {
    const diff = Math.min(leftLength - minContext, minContext - rightLength);
    if (diff > 0) {
      rightLength += diff;
      leftLength -= diff;
    }
  }

  return {
    prefix:
      prefix.length > leftLength ? ellipsis + prefix.slice(-leftLength) : prefix,
    suffix:
      suffix.length > rightLength
        ? suffix.slice(0, rightLength) + ellipsis
        : suffix
  };
}

function stringToMatch(str: string): Match[] {
  return [
    {
      prefix: str,
      match: "",
      suffix: "",
      id: undefined
    }
  ];
}

interface MatchScoreOptions {
  lengthMultiplier: number;
  positionPenalty: number;
  consecutiveBonus: number;
  repetitionPenalty: number;
  uniqueTokenBonus: number;
  completeWordBonus: number;
}

const DEFAULT_SCORE_OPTIONS: MatchScoreOptions = {
  lengthMultiplier: 1.5,
  positionPenalty: 0.05,
  consecutiveBonus: 2,
  repetitionPenalty: 0.5,
  uniqueTokenBonus: 10,
  completeWordBonus: 5
};

function isCompleteWord(match: Match) {
  const prefixEndsWithSpace = /\s$/.test(match.prefix) || match.prefix === "";
  const suffixStartsWithSpace = /^\s/.test(match.suffix) || match.suffix === "";
  return prefixEndsWithSpace && suffixStartsWithSpace;
}

function getMatchScore(
  matches: Match[],
  tokens: string[],
  options: MatchScoreOptions = DEFAULT_SCORE_OPTIONS
) {
  let score = 0;
  let lastMatchText = "";
  let repetitionCount = 0;
  const uniqueTokens = new Set<string>();

  matches.forEach((match, index) => {
    const matchText = match.match.toLowerCase();
    let matchScore = match.match.length * options.lengthMultiplier;
    const matchingTokens = tokens.filter((token) =>
      matchText.includes(token.toLowerCase())
    );

    matchingTokens.forEach((token) => uniqueTokens.add(token.toLowerCase()));

    if (isCompleteWord(match)) {
      matchScore += options.completeWordBonus;
    }

    matchScore *= 1 - index * options.positionPenalty;

    if (index > 0) {
      if (matchText === lastMatchText) {
        repetitionCount++;
        matchScore *= Math.pow(options.repetitionPenalty, repetitionCount);
      } else {
        matchScore *= options.consecutiveBonus;
        repetitionCount = 0;
      }
    }

    lastMatchText = matchText;
    score += matchScore;
  });

  return score + uniqueTokens.size * options.uniqueTokenBonus;
}

function removeDiacritics(text: string) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdo",
  "big",
  "button",
  "cite",
  "code",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "map",
  "object",
  "output",
  "q",
  "samp",
  "script",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "textarea",
  "time",
  "tt",
  "var"
]);
