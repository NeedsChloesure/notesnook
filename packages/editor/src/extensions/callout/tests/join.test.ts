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

import { expect, test } from "vitest";
import { createEditor } from "../../../../test-utils/index.js";
import { Callout } from "../index.js";
import { Paragraph } from "../../paragraph/index.js";
import { Heading } from "../../heading/index.js";

/**
 * Regression test: pressing Backspace at the start of an empty paragraph
 * right after a callout used to crash the editor with
 * `TransformError: Cannot join paragraph onto callout`.
 *
 * The crash happened in prosemirror-commands' `deleteBarrier` wrap branch:
 * after wrapping the empty paragraph inside the callout, it tried to join at a
 * stale (unmapped) position where `canJoin` wrongly reported true. See
 * packages/editor/patches/prosemirror-commands+1.5.2.patch.
 */
test("backspace on an empty paragraph after a callout does not crash", async () => {
  const editorElement = document.createElement("div");
  const { editor } = createEditor({
    element: editorElement,
    initialContent:
      `<div class="callout" data-callout-type="info">` +
      `<h4>INFO</h4><p>text</p></div><p></p><p></p>`,
    extensions: {
      callout: Callout,
      paragraph: Paragraph,
      heading: Heading
    }
  });

  // Place the cursor at the start of the first empty paragraph after the callout.
  let emptyPos = -1;
  let count = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "") {
      if (count === 0) emptyPos = pos + 1;
      count++;
    }
    return true;
  });
  expect(emptyPos).toBeGreaterThan(-1);
  editor.commands.setTextSelection(emptyPos);

  let error: Error | undefined;
  try {
    const event = new KeyboardEvent("keydown", { key: "Backspace" });
    editor.view.dom.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (e) {
    error = e as Error;
  }

  expect(error).toBeUndefined();
});
