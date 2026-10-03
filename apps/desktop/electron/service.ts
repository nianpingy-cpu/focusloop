import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FocusLoopEngine } from '@focusloop/agent-core';
import { createProviderSelection, DeepSeekProvider } from '@focusloop/llm-provider';
import { openDatabase, FocusLoopStore } from '@focusloop/persistence';
import type { DataInfo, DeleteDataResponse, OpenDataFolderResponse } from '@focusloop/shared-types';
import { startBridgeServer, type BridgeServerHandle } from './bridge/server';
import { databaseFiles, deleteFiles } from './data-files';

export interface FocusLoopService {
  readonly engine: FocusLoopEngine;
  readonly store: FocusLoopStore;
  readonly databasePath: string;
  bridge: BridgeServerHandle | null;
  dispose(): void;
  /**
   * Where the data is, read from Electron rather than assembled from a template.
   *
   * `directory` is `app.getPath('userData')` — which follows `--user-data-dir`, a portable install or a
   * moved profile — and `databasePath` is the file the store actually has open. A hand-written path in
   * the renderer would be a claim about where the data is; this is the answer.
   */
  getDataInfo(): DataInfo;
  openDataFolder(): Promise<OpenDataFolderResponse>;
  /**
   * Deletes every file this app has written and returns it to a first-run state, without a restart.
   *
   * Reports what it did rather than assuming it worked: see `DeleteDataResponse`.
   */
  deleteAllData(): Promise<DeleteDataResponse>;
}

let singleton: FocusLoopService | null = null;

export interface CreateServiceOptions {
  readonly databasePath?: string;
  readonly userDataPath?: string;
  readonly deepSeekApiKey?: string | undefined;
  readonly simulatorEnabled?: boolean;
  readonly bridgePort?: number;
  readonly startBridge?: boolean;
}

/**
 * Builds the single application service. Local-first: the database lives in the
 * OS user-data directory and no network provider is created unless the user has
 * supplied a key.
 */
export function createService(options: CreateServiceOptions = {}): FocusLoopService {
  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const databasePath = options.databasePath ?? join(userDataPath, 'focusloop.sqlite');

  const store = new FocusLoopStore(openDatabase(databasePath));
  store.initialize();

  const apiKey = options.deepSeekApiKey ?? process.env['FOCUSLOOP_DEEPSEEK_API_KEY'];
  const remote = apiKey ? new DeepSeekProvider({ apiKey }) : null;
  const providers = createProviderSelection(remote);

  const engine = new FocusLoopEngine({
    store,
    providers,
    simulatorEnabled: options.simulatorEnabled ?? !app.isPackaged,
  });
  engine.seedBuiltInCourses();

  const service: FocusLoopService = {
    engine,
    store,
    databasePath,
    bridge: null,
    getDataInfo: () => ({ directory: userDataPath, databasePath }),
    // An OS that refuses to open the file manager is a reportable outcome, not a crash: `openPath`
    // answers with the reason as a string rather than throwing.
    openDataFolder: async () => ({ opened: (await shell.openPath(userDataPath)) === '' }),
    deleteAllData: async () => {
      /*
       * Close first. On Windows an open handle cannot be unlinked at all, and everywhere else a delete
       * underneath a live connection leaves the connection writing to a file with no name left.
       */
      store.close();
      const outcome = deleteFiles(databaseFiles(databasePath));

      /*
       * Whether the deletion happened is a question about the disk, not about this function having run:
       * the file being absent is exactly a first-run state, and the file being present is exactly the
       * case where claiming success would be a lie. A database that was never there counts as gone.
       */
      if (existsSync(databasePath)) {
        // The learner's data is still there, so the app has to keep working: reopen the file that
        // survived rather than leave a closed store behind a failure message.
        store.replaceDatabase(openDatabase(databasePath));
        return { ok: false, reason: outcome.reason ?? 'failed', removed: outcome.removed };
      }

      /*
       * A fresh database: schema, then the built-in course the catalogue is supposed to have on a first
       * run. The store keeps its identity — the engine and every IPC handler hold this object — so the
       * connection is what is replaced, which is the only way the app keeps running without a restart.
       */
      store.replaceDatabase(openDatabase(databasePath));
      engine.discardTransientData();
      engine.seedBuiltInCourses();

      return { ok: true, reason: null, removed: outcome.removed };
    },
    dispose: () => {
      void service.bridge?.close();
      store.close();
    },
  };

  return service;
}

/**
 * Local-first, and the bridge is optional: if the port is taken the app still
 * starts and the golden path still works through the simulator.
 */
export async function startBridge(
  service: FocusLoopService,
  port?: number,
): Promise<BridgeServerHandle | null> {
  try {
    service.bridge = await startBridgeServer({
      engine: service.engine,
      ...(port === undefined ? {} : { port }),
    });
    service.store.setMeta('bridge_token', service.bridge.token);
    return service.bridge;
  } catch (error) {
    console.warn('FocusLoop bridge could not start:', error);
    service.bridge = null;
    return null;
  }
}

export function getService(): FocusLoopService {
  singleton ??= createService();
  return singleton;
}

export function resetServiceForTests(): void {
  singleton?.dispose();
  singleton = null;
}
