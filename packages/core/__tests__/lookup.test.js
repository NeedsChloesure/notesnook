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

import {
  noteTest,
  TEST_NOTE,
  notebookTest,
  TEST_NOTEBOOK2,
  databaseTest
} from "./utils/index.ts";
import { test, expect, describe } from "vitest";

const content = {
  ...TEST_NOTE.content,
  data: "<p>hello i am a note of the world</p>"
};

//TODO
test("search notes", () =>
  noteTest({
    content: content
  }).then(async ({ db }) => {
    await db.notes.add(TEST_NOTE);
    await db.notes.add({
      content: { data: "<p>hb <b>kb</b> ch</p>", type: "tiptap" },
      title: "hello"
    });

    expect(await db.lookup.notes("note of the world").ids()).toHaveLength(1);
    expect(await db.lookup.notes("hb kb ch").ids()).toHaveLength(1);
  }));

test("search notes (remove diacritics)", () =>
  noteTest({
    content: {
      type: "tiptap",
      data: "<p>hello i am à la maison</p>"
    }
  }).then(async ({ db }) => {
    await db.notes.add(TEST_NOTE);
    let filtered = await db.lookup.notes("a la maison").ids();
    expect(filtered).toHaveLength(1);
  }));

test("search notes (remove html tags)", () =>
  noteTest({
    content: {
      type: "tiptap",
      data: "<p block-id='1'>hello this is a word</p>"
    }
  }).then(async ({ db }) => {
    await db.notes.add(TEST_NOTE);
    expect(await db.lookup.notes("block").ids()).toHaveLength(0);
    expect(await db.lookup.notes("hello").ids()).toHaveLength(2);
    expect(await db.lookup.notes("word").ids()).toHaveLength(1);
  }));

test("search notes with a locked note", () =>
  noteTest({
    content: content
  }).then(async ({ db }) => {
    const noteId = await db.notes.add(TEST_NOTE);
    await db.vault.create("password");
    await db.vault.add(noteId);
    expect(await db.lookup.notes("note of the world").ids()).toHaveLength(1);
    expect(await db.lookup.notes("format").ids()).toHaveLength(0);
  }));

test("search notes with an empty note", () =>
  noteTest({
    content: content
  }).then(async ({ db }) => {
    await db.notes.add({
      title: "world is a heavy tune",
      content: { type: "tiptap", data: "<p><br></p>" }
    });
    let filtered = await db.lookup.notes("heavy tune").ids();
    expect(filtered).toHaveLength(1);
  }));

test("search notebooks", () =>
  notebookTest().then(async ({ db }) => {
    await db.notebooks.add(TEST_NOTEBOOK2);
    let filtered = await db.lookup.notebooks("Description").ids();
    expect(filtered.length).toBeGreaterThan(0);
  }));

test("search should not return trashed notes", () =>
  databaseTest().then(async (db) => {
    const id = await db.notes.add({
      title: "world is a heavy tune"
    });
    await db.notes.moveToTrash(id);

    const filtered = await db.lookup.notes("heavy tune").ids();

    expect(filtered).toHaveLength(0);
  }));

test("search should return restored notes", () =>
  databaseTest().then(async (db) => {
    const id = await db.notes.add({
      title: "world is a heavy tune"
    });
    await db.notes.moveToTrash(id);
    await db.trash.restore(id);

    const filtered = await db.lookup.notes("heavy tune").ids();

    expect(filtered).toHaveLength(1);
  }));

test("search reminders", () =>
  databaseTest().then(async (db) => {
    await db.reminders.add({
      title: "remind me",
      description: "please do",
      date: Date.now()
    });

    const titleSearch = await db.lookup.reminders("remind me").ids();
    expect(titleSearch).toHaveLength(1);
    const descriptionSearch = await db.lookup.reminders("please do").ids();
    expect(descriptionSearch).toHaveLength(1);
  }));

test("search notes should support filter-only queries", () =>
  databaseTest().then(async (db) => {
    const favoriteId = await db.notes.add({
      title: "favorite note",
      favorite: true
    });
    await db.notes.add({
      title: "regular note",
      favorite: false
    });

    const filtered = await db.lookup.notes("favorite:true").ids();

    expect(filtered).toContain(favoriteId);
    expect(filtered).toHaveLength(1);
  }));

test("search notes should preserve OR matches when short tokens require local scan", () =>
  databaseTest().then(async (db) => {
    await db.notes.add({
      title: "hello world"
    });
    await db.notes.add({
      title: "tiny token",
      content: { type: "tiptap", data: "<p>hb</p>" }
    });

    const filtered = await db.lookup.notes("hello OR hb").ids();

    expect(filtered).toHaveLength(2);
  }));

test("search notes should exclude tagged notes with tagged:false", () =>
  databaseTest().then(async (db) => {
    const untaggedId = await db.notes.add({
      title: "untagged note"
    });
    const taggedId = await db.notes.add({
      title: "tagged note"
    });
    const tagId = await db.tags.add({
      title: "project"
    });
    await db.relations.add(
      { type: "tag", id: tagId },
      { type: "note", id: taggedId }
    );

    const filtered = await db.lookup.notes("tagged:false").ids();

    expect(filtered).toContain(untaggedId);
    expect(filtered).not.toContain(taggedId);
    expect(filtered).toHaveLength(1);
  }));

test("search notes should exclude tagged matches with tagged:false", () =>
  databaseTest().then(async (db) => {
    const untaggedId = await db.notes.add({
      title: "shared search text"
    });
    const taggedId = await db.notes.add({
      title: "shared search text"
    });
    const tagId = await db.tags.add({
      title: "project"
    });
    await db.relations.add(
      { type: "tag", id: tagId },
      { type: "note", id: taggedId }
    );

    const filtered = await db.lookup.notes("shared search text tagged:false").ids();

    expect(filtered).toEqual([untaggedId]);
  }));

test("search notes should exclude colored notes with colored:false", () =>
  databaseTest().then(async (db) => {
    const plainId = await db.notes.add({
      title: "plain note"
    });
    const coloredId = await db.notes.add({
      title: "colored note"
    });
    const colorId = await db.colors.add({
      title: "red",
      colorCode: "#ff0000"
    });
    await db.relations.add(
      { type: "color", id: colorId },
      { type: "note", id: coloredId }
    );

    const filtered = await db.lookup.notes("colored:false").ids();

    expect(filtered).toContain(plainId);
    expect(filtered).not.toContain(coloredId);
    expect(filtered).toHaveLength(1);
  }));

test("search notes should include only filed notes with in_notebook:true", () =>
  databaseTest().then(async (db) => {
    const filedId = await db.notes.add({
      title: "filed note"
    });
    await db.notes.add({
      title: "loose note"
    });
    const notebookId = await db.notebooks.add({
      title: "Projects"
    });
    await db.relations.add(
      { type: "notebook", id: notebookId },
      { type: "note", id: filedId }
    );

    const filtered = await db.lookup.notes("in_notebook:true").ids();

    expect(filtered).toEqual([filedId]);
  }));

test("search notes should exclude filed notes with in_notebook:false", () =>
  databaseTest().then(async (db) => {
    const filedId = await db.notes.add({
      title: "filed note"
    });
    const looseId = await db.notes.add({
      title: "loose note"
    });
    const notebookId = await db.notebooks.add({
      title: "Projects"
    });
    await db.relations.add(
      { type: "notebook", id: notebookId },
      { type: "note", id: filedId }
    );

    const filtered = await db.lookup.notes("in_notebook:false").ids();

    expect(filtered).toEqual([looseId]);
  }));

test("search notebook scope should keep notebook selector for in_notebook:false", () =>
  databaseTest().then(async (db) => {
    const filedId = await db.notes.add({
      title: "scoped note"
    });
    const notebookId = await db.notebooks.add({
      title: "Projects"
    });
    await db.relations.add(
      { type: "notebook", id: notebookId },
      { type: "note", id: filedId }
    );

    const selector = db.relations
      .from({ type: "notebook", id: notebookId }, "note")
      .selector;

    expect(await db.lookup.notes("in_notebook:true", selector).ids()).toEqual([
      filedId
    ]);
    expect(await db.lookup.notes("in_notebook:false", selector).ids()).toEqual(
      []
    );
  }));

test("search notes should include archived results with archived:true", () =>
  databaseTest().then(async (db) => {
    await db.notes.add({
      title: "shared search text"
    });
    const archivedId = await db.notes.add({
      title: "shared search text"
    });
    await db.notes.archive(true, archivedId);

    const filtered = await db.lookup.notes("shared search text archived:true").ids();

    expect(filtered).toContain(archivedId);
    expect(filtered).toHaveLength(2);
  }));

test("search notes should return only archived results with archived:only", () =>
  databaseTest().then(async (db) => {
    await db.notes.add({
      title: "shared archived text"
    });
    const archivedId = await db.notes.add({
      title: "shared archived text"
    });
    await db.notes.archive(true, archivedId);

    expect(await db.notes.archived.ids()).toEqual([archivedId]);
    expect(
      await db.notes.exportable.where((eb) => eb("notes.archived", "==", true)).ids()
    ).toEqual([archivedId]);

    const filtered = await db.lookup.notes("shared archived text archived:only").ids();

    expect(filtered).toEqual([archivedId]);
  }));

describe("notesWithHighlighting", () => {
  test("search notes with parentheses in query should load the item", () =>
    noteTest({
      title: "(with parantheses)"
    }).then(async ({ db }) => {
      await db.notes.add(TEST_NOTE);
      const filtered = await db.lookup.notesWithHighlighting(
        "(with parantheses)",
        db.notes.all
      );
      const item = await filtered.item(0);
      expect(item.item).toBeDefined();
    }));

  test("search notes with brackets in query should load the item", () =>
    noteTest({
      title: "[with brackets]"
    }).then(async ({ db }) => {
      await db.notes.add(TEST_NOTE);
      const filtered = await db.lookup.notesWithHighlighting(
        "[with brackets]",
        db.notes.all
      );
      const item = await filtered.item(0);
      expect(item.item).toBeDefined();
    }));

  test("search should be diacritic agnostic", () =>
    databaseTest().then(async (db) => {
      await db.notes.add({ title: "outdoor café" });
      await db.notes.add({
        title: "today",
        content: { type: "tiptap", data: "<p>I went to café</p>" }
      });
      await db.notes.add({ title: "indoor cafe" });
      await db.notes.add({
        title: "yesterday",
        content: { type: "tiptap", data: "<p>I went to a cafe</p>" }
      });

      const searchWithoutDiacritics = await db.lookup.notesWithHighlighting(
        "cafe",
        db.notes.all
      );
      expect(searchWithoutDiacritics.length).toBe(4);

      const searchWithDiacritics = await db.lookup.notesWithHighlighting(
        "café",
        db.notes.all
      );
      expect(searchWithDiacritics.length).toBe(4);
    }));
});
