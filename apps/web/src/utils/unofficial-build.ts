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

import { ConfirmDialog } from "../dialogs/confirm";

// This build is maintained in a personal fork. Keep these in one place so
// every "come to this repo instead" link stays consistent.
export const FORK_REPO_URL = "https://github.com/NeedsChloesure/notesnook";
export const FORK_REPO_BRANCH = "agentic-nook";
export const FORK_ISSUES_URL = `${FORK_REPO_URL}/issues`;
export const FORK_NEW_ISSUE_URL = `${FORK_REPO_URL}/issues/new`;
export const FORK_LICENSE_URL = `${FORK_REPO_URL}/blob/${FORK_REPO_BRANCH}/LICENSE`;

const UNOFFICIAL_BUILD_MESSAGE =
  "You are using an **unofficial build** of Notesnook, maintained in a personal fork — not by the Notesnook team.\n\nThis link points to the upstream Notesnook project, which is not responsible for this build and cannot help with it.";

/**
 * Open an external (upstream/community) link, first reminding the user that
 * this is an unofficial build. Community and help links are kept for
 * reference, but users should not mistake them for support for this build.
 */
export async function openExternalLink(url: string) {
  const confirmed = await ConfirmDialog.show({
    title: "Unofficial build",
    message: UNOFFICIAL_BUILD_MESSAGE,
    positiveButtonText: "Open link",
    negativeButtonText: "Cancel",
    width: 400
  });
  if (confirmed) window.open(url, "_blank");
}
