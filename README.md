<p align="center">
<img style="align:center;" src="./resources/icon.png" alt="Notesnook Logo" width="100" />
</p>

<h1 align="center">Notesnook</h1>
<h3 align="center">An end-to-end encrypted note taking alternative to Evernote.</h3>
<p align="center">
<a href="https://notesnook.com/">Website</a> | <a href="https://notesnook.com/about">About us</a> | <a href="https://notesnook.com/roadmap">Roadmap</a> | <a href="https://notesnook.com/downloads">Downloads</a> | <a href="https://twitter.com/@notesnook">Twitter</a> | <a href="https://discord.gg/5davZnhw3V">Discord</a>
</p>

> **This is a personal fork of Notesnook** ([`NeedsChloesure/notesnook`](https://github.com/NeedsChloesure/notesnook)). It is based on a copy of upstream that is updated and upstreamed only occasionally, so [`agentic-nook`](https://github.com/NeedsChloesure/notesnook/tree/agentic-nook) — not upstream `master` — is the source of truth for anything in this repository.

## Overview

Notesnook is a free (as in speech) & open-source note-taking app focused on user privacy & ease of use. To ensure zero knowledge principles, Notesnook encrypts everything on your device using `XChaCha20-Poly1305` & `Argon2`.

Notesnook is our **proof** that privacy does _not_ (always) have to come at the cost of convenience. We aim to provide users peace of mind & 100% confidence that their notes are safe and secure. The decision to go fully open source is one of the most crucial steps towards that.

This repository contains all the code required to build & use the Notesnook web, desktop & mobile clients. If you are looking for a full feature list or screenshots, please check the [website](https://notesnook.com/).

## Branch: `agentic-nook`

This branch is based on the web `v3.4.9` release tag (`430ee0fb`) and carries the following changes on top of it:

- **Worker-coordination-free SQLite boot (web).** The cross-tab layer built on `SharedWorker` + `BroadcastChannel` + Web Locks has been removed. The web client always starts one dedicated SQLite worker per tab and talks to it directly. This removes the `Could not find a provider port to communicate with.` failure at startup — and the indefinite "Decrypting your notes" screen it could produce — which shows up in agent-driven / automated browsers.
  - Removed: `apps/web/src/common/sqlite/shared-service.ts`, `apps/web/src/common/sqlite/shared-service.worker.ts`, `WaSqliteWorkerMultipleTabDriver`, and the `multiTab` dialect option.
  - Kept: OPFS storage and SQL execution off the main thread. The dedicated worker stays because OPFS `createSyncAccessHandle` is only available in workers.
- **Single tab is the supported mode.** SQLite opens OPFS with an exclusive access handle, so a second tab may contend for the database lock.

## Developer guide

### Technologies & languages

Notesnook is built using the following technologies:

1. JavaScript/Typescript — this repo is in a hybrid state. A lot of the newer code is being written in Typescript & the old code is slowly being ported over.
2. React — the whole front-end across all platforms is built using React.
3. React Native — For mobile apps we are using React Native
4. Electron — For desktop app
5. NPM — listed here because we **don't** use Yarn or PNPM or XYZ across any of our projects.

> **Note: Each project in the monorepo contains its own architecture details which you can refer to.**

### Monorepo structure

| Name                       | Path                                               | Description                                                          |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `@notesnook/web`           | [/apps/web](/apps/web)                             | Web client                                                           |
| `@notesnook/desktop`       | [/apps/desktop](/apps/desktop)                     | Desktop client                                                       |
| `@notesnook/mobile`        | [/apps/mobile](/apps/mobile)                       | Android/iOS clients                                                  |
| `@notesnook/web-clipper`   | [/extensions/web-clipper](/extensions/web-clipper) | Web clipper                                                          |
| `@notesnook/core`          | [/packages/core](/packages/core)                   | Shared core between all platforms                                    |
| `@notesnook/crypto`        | [/packages/crypto](/packages/crypto)               | Cryptography library wrapper around libsodium                        |
| `@notesnook/clipper`       | [/packages/clipper](/packages/clipper)             | Web clipper core handling everything related to actual page clipping |
| `@notesnook/editor`        | [/packages/editor](/packages/editor)               | Notesnook editor + all extensions                                    |
| `@notesnook/editor-mobile` | [/packages/editor-mobile](/packages/editor-mobile) | A very thin wrapper around `@notesnook/editor` for mobile clients    |
| `@notesnook/logger`        | [/packages/logger](/packages/logger)               | Simple & pluggable logger                                            |
| `@notesnook/sodium`        | [/packages/sodium](/packages/sodium)               | Wrapper around libsodium to support Node.js & Browser                |
| `@notesnook/streamable-fs` | [/packages/streamable-fs](/packages/streamable-fs) | Streaming interface around an IndexedDB based file system            |
| `@notesnook/theme`         | [/packages/theme](/packages/theme)                 | The core theme used in web & desktop clients                         |

### Contributing guidelines

If you are interested in contributing to this fork, check out the [contributing guidelines](/CONTRIBUTING.md). You'll find all the relevant information such as [style guideline](/CONTRIBUTING.md#style-guidelines), [how to make a PR](/CONTRIBUTING.md#opening--submitting-a-pull-request), [how to commit](/CONTRIBUTING.md#commit-guidelines) etc., there. Feature work and fixes for the changes described above should target the [`agentic-nook`](https://github.com/NeedsChloesure/notesnook/tree/agentic-nook) branch.

### Reporting issues

**Do not report bugs, crashes or support requests about this fork to the upstream Notesnook team** — they do not own these changes and cannot help with them. Report everything here instead:

1. [Open an issue](https://github.com/NeedsChloesure/notesnook/issues/new)
2. [Browse existing issues](https://github.com/NeedsChloesure/notesnook/issues)

Please mention the branch (`agentic-nook`) and the client you are using (web, desktop or mobile) so the report is actionable.

## Additional Resources

- [Migrating & Importing your data from other apps — Importer](https://notesnook.com/help/importing-notes)
- [Privacy policy](https://notesnook.com/privacy) & [Terms of service](https://notesnook.com/terms)
- [Verify Notesnook encryption claims yourself — Vericrypt](https://vericrypt.notesnook.com/)
- [Why Notesnook requires an email address?](https://blog.notesnook.com/why-notesnook-requires-an-email-address/)
