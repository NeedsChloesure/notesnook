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

import { match } from "fuzzyjs";
import Database from "./index.js";
import {
  Item,
  Note,
  Notebook,
  Reminder,
  SortOptions,
  TrashItem
} from "../types.js";
import { DatabaseSchema } from "../database/index.js";
import { AnyColumnWithTable } from "@streetwriters/kysely";
import { FilteredSelector } from "../database/sql-collection.js";
import { VirtualizedGrouping } from "../utils/virtualized-grouping.js";
import { getSortSelectors, groupArray } from "../utils/grouping.js";
import { fuzzy } from "../utils/fuzzy.js";
import {
  rebuildNoteSearchIndex,
  searchNoteIds,
  searchNotesWithHighlighting,
  shouldExpandArchivedSearch
} from "./note-search.js";
import { transformQuery } from "../utils/query-transformer.js";

type SearchResults<T> = {
  sorted: (sortOptions?: SortOptions) => Promise<VirtualizedGrouping<T>>;
  items: (limit?: number, sortOptions?: SortOptions) => Promise<T[]>;
  ids: (limit?: number, sortOptions?: SortOptions) => Promise<string[]>;
};

type FuzzySearchField<T> = {
  weight?: number;
  name: keyof T;
  column: AnyColumnWithTable<DatabaseSchema, keyof DatabaseSchema>;
  ignore?: boolean;
};

export default class Lookup {
  constructor(private readonly db: Database) {}

  notes(query: string, notes?: FilteredSelector<Note>): SearchResults<Note> {
    const selector =
      notes ||
      (shouldExpandArchivedSearch(transformQuery(query).archived)
        ? this.db.notes.exportable
        : this.db.notes.all);

    return this.toSearchResults(async (limit, sortOptions) => {
      const ids = await searchNoteIds(this.db, query, selector, sortOptions);
      return limit === undefined ? ids : ids.slice(0, limit);
    }, selector);
  }

  notesWithHighlighting(
    query: string,
    notes: FilteredSelector<Note>,
    sortOptions?: SortOptions
  ) {
    return searchNotesWithHighlighting(this.db, query, notes, sortOptions);
  }

  notebooks(query: string) {
    const fields: FuzzySearchField<Notebook>[] = [
      { name: "id", column: "notebooks.id", weight: -100, ignore: true },
      { name: "title", column: "notebooks.title", weight: 10 },
      {
        name: "description",
        column: "notebooks.description"
      }
    ];
    return this.search(this.db.notebooks.all, query, fields);
  }

  tags(query: string) {
    return this.search(this.db.tags.all, query, [
      { name: "id", column: "tags.id", weight: -100, ignore: true },
      { name: "title", column: "tags.title" }
    ]);
  }

  reminders(query: string) {
    const fields: FuzzySearchField<Reminder>[] = [
      { name: "id", column: "reminders.id", weight: -100, ignore: true },
      { name: "title", column: "reminders.title", weight: 10 },
      {
        name: "description",
        column: "reminders.description"
      }
    ];
    return this.search(this.db.reminders.all, query, fields);
  }

  trash(query: string): SearchResults<TrashItem> {
    return {
      sorted: async (sortOptions?: SortOptions) => {
        const { ids, items } = await this.filterTrash(
          query,
          undefined,
          sortOptions
        );
        return new VirtualizedGrouping<TrashItem>(
          ids.length,
          this.db.options.batchSize,
          () => Promise.resolve(ids),
          async (start, end) => ({
            ids: ids.slice(start, end),
            items: items.slice(start, end)
          })
        );
      },
      items: async (limit, sortOptions?: SortOptions) => {
        const { items } = await this.filterTrash(query, limit, sortOptions);
        return items;
      },
      ids: () => this.filterTrash(query).then(({ ids }) => ids)
    };
  }

  attachments(query: string) {
    return this.search(this.db.attachments.all, query, [
      { name: "id", column: "attachments.id", weight: -100 },
      { name: "filename", column: "attachments.filename", weight: 5 },
      { name: "mimeType", column: "attachments.mimeType" },
      { name: "hash", column: "attachments.hash" }
    ]);
  }

  private search<T extends Item>(
    selector: FilteredSelector<T>,
    query: string,
    fields: FuzzySearchField<T>[]
  ) {
    return this.toSearchResults(async (limit, sortOptions) => {
      const results = await this.filter(selector, query, fields, {
        sortOptions,
        limit
      });
      return results.map((item) => item.id);
    }, selector);
  }

  private async filter<T extends Item>(
    selector: FilteredSelector<T>,
    query: string,
    fields: readonly FuzzySearchField<T>[],
    options: {
      limit?: number;
      sortOptions?: SortOptions;
      prefix?: string;
      suffix?: string;
    } = {}
  ) {
    const columns = fields.map((field) => field.column);
    const items = await selector.fields(columns).items();
    selector.fields([]);

    return fuzzy(
      query,
      items,
      (item) => item.id,
      Object.fromEntries(
        fields
          .filter((field) => !field.ignore)
          .map((field) => [field.name, field.weight || 1])
      ) as Record<keyof T, number>,
      options
    );
  }

  private toSearchResults<T extends Item>(
    ids: (limit?: number, sortOptions?: SortOptions) => Promise<string[]>,
    selector: FilteredSelector<T>
  ): SearchResults<T> {
    return {
      sorted: async (sortOptions) =>
        this.toVirtualizedGrouping(
          await ids(undefined, sortOptions),
          selector,
          sortOptions
        ),
      items: async (limit, sortOptions) =>
        this.toItems(await ids(limit, sortOptions), selector, sortOptions),
      ids
    };
  }

  private async filterTrash(
    query: string,
    limit?: number,
    sortOptions?: SortOptions
  ) {
    const items = await this.db.trash.all();
    const results: Map<string, { rank: number; item: TrashItem }> = new Map();

    for (const item of items) {
      if (limit !== undefined && results.size === limit) break;

      const result = match(query, item.title);
      if (!result.match) continue;
      results.set(item.id, { rank: result.score, item });
    }

    const sorted = Array.from(results.entries());
    if (!sortOptions || sortOptions.sortBy === "relevance") {
      sorted.sort(
        sortOptions?.sortDirection === "desc"
          ? (a, b) => a[1].rank - b[1].rank
          : (a, b) => b[1].rank - a[1].rank
      );
    } else {
      const selector = getSortSelectors(sortOptions)[sortOptions.sortDirection];
      sorted.sort((a, b) => selector(a[1].item, b[1].item));
    }

    return {
      ids: sorted.map((entry) => entry[0]),
      items: sorted.map((entry) => entry[1].item)
    };
  }

  private toVirtualizedGrouping<T extends Item>(
    ids: string[],
    selector: FilteredSelector<T>,
    sortOptions?: SortOptions
  ) {
    if (sortOptions?.sortBy === "relevance") sortOptions = undefined;

    return new VirtualizedGrouping<T>(
      ids.length,
      this.db.options.batchSize,
      () => Promise.resolve(ids),
      async (start, end) => {
        const requestedIds = ids.slice(start, end);
        const items = await selector.items(requestedIds, sortOptions);
        const orderedItems = sortOptions
          ? items
          : orderItemsByIds(requestedIds, items);

        return {
          ids: orderedItems.map((item) => item.id),
          items: orderedItems
        };
      },
      (items) => groupArray(items, () => `${items.length} results`)
    );
  }

  private async toItems<T extends Item>(
    ids: string[],
    selector: FilteredSelector<T>,
    sortOptions?: SortOptions
  ) {
    if (!ids.length) return [];
    if (sortOptions?.sortBy === "relevance") sortOptions = undefined;

    const items = await selector.items(ids, sortOptions);
    return sortOptions ? items : orderItemsByIds(ids, items);
  }

  async rebuild() {
    await rebuildNoteSearchIndex(this.db);
  }
}

function orderItemsByIds<T extends Item>(ids: string[], items: T[]) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return ids
    .map((id) => itemsById.get(id))
    .filter((item): item is T => !!item);
}
