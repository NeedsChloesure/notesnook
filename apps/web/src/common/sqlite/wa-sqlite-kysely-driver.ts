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

import type {
  DatabaseConnection,
  Driver,
  QueryResult
} from "@streetwriters/kysely";
import { CompiledQuery } from "@streetwriters/kysely";
import Worker from "./sqlite.worker.ts?worker";
import type { SQLiteWorker } from "./sqlite.worker";
import SQLiteSyncURI from "./wa-sqlite.wasm?url";
import SQLiteAsyncURI from "./wa-sqlite-async.wasm?url";
import { Mutex } from "async-mutex";
import { Remote, wrap } from "comlink";

type Config = {
  dbName: string;
  async: boolean;
  encrypted: boolean;
};

export class WaSqliteWorkerSingleTabDriver implements Driver {
  private connection?: DatabaseConnection;
  private connectionMutex = new Mutex();
  private readonly worker;

  constructor(private readonly config: Config) {
    console.log("single tab driver", config.dbName);
    this.worker = wrap<SQLiteWorker>(new Worker({ name: config.dbName }));
  }

  async init(): Promise<void> {
    await this.worker.open(this.config.dbName, {
      async: this.config.async,
      encrypted: this.config.encrypted,
      url: this.config.async ? SQLiteAsyncURI : SQLiteSyncURI
    });
    this.connection = new WaSqliteWorkerConnection(
      this.worker,
      this.config.async
    );
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.connection) throw new Error("Driver not initialized.");

    // SQLite only has one single connection. We use a mutex here to wait
    // until the single connection has been released.
    await this.connectionMutex.waitForUnlock();
    await this.connectionMutex.acquire();
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    this.connectionMutex.release();
  }

  async destroy(): Promise<void> {
    await this.worker.close();
  }

  async delete() {
    await this.worker.delete(this.config.dbName, {
      async: this.config.async,
      encrypted: this.config.encrypted,
      url: this.config.async ? SQLiteAsyncURI : SQLiteSyncURI
    });
  }

  async export() {
    return await this.worker.export(this.config.dbName, {
      async: this.config.async,
      encrypted: this.config.encrypted,
      url: this.config.async ? SQLiteAsyncURI : SQLiteSyncURI
    });
  }
}

class WaSqliteWorkerConnection implements DatabaseConnection {
  #queryMutex = new Mutex();
  constructor(
    private readonly worker: SQLiteWorker | Remote<SQLiteWorker>,
    private readonly sequential = false
  ) {}

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("wasqlite driver doesn't support streaming");
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery<unknown>
  ): Promise<QueryResult<R>> {
    if (this.sequential) {
      return this.#queryMutex.runExclusive(async () =>
        this.#_executeQuery(compiledQuery)
      );
    }
    return this.#_executeQuery(compiledQuery);
  }

  #_executeQuery<R>(
    compiledQuery: CompiledQuery<unknown>
  ): Promise<QueryResult<R>> {
    const { parameters, sql, query } = compiledQuery;
    const mode =
      query.kind === "SelectQueryNode"
        ? "query"
        : query.kind === "RawNode"
        ? "raw"
        : "exec";
    return this.worker.run(mode, sql, parameters as any) as Promise<
      QueryResult<R>
    >;
  }
}
