import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { AutomaticUpdateService } from "./automatic-update-service.js";
import { AUTOMATIC_UPDATE_IPC_CHANNELS } from "../shared/automatic-updates.js";

export interface AutomaticUpdateIpcOptions {
  readonly ipc: Pick<IpcMain, "handle" | "removeHandler">;
  readonly service: AutomaticUpdateService;
  readonly trustedSender: (event: IpcMainInvokeEvent) => boolean;
}

function requireTrustedSender(
  options: AutomaticUpdateIpcOptions,
  event: IpcMainInvokeEvent,
): void {
  if (!options.trustedSender(event)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

function fixedResult<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

async function fixedAsyncResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

/** Fixed update commands only. No renderer-controlled URL, channel, path, or
 * updater option crosses this boundary. */
export function registerAutomaticUpdateIpcHandlers(
  options: AutomaticUpdateIpcOptions,
): () => void {
  const remove = (): void => {
    for (const channel of Object.values(AUTOMATIC_UPDATE_IPC_CHANNELS)) {
      options.ipc.removeHandler(channel);
    }
  };
  remove();
  options.ipc.handle(AUTOMATIC_UPDATE_IPC_CHANNELS.status, (event) => {
    requireTrustedSender(options, event);
    return fixedResult(() => options.service.status());
  });
  options.ipc.handle(
    AUTOMATIC_UPDATE_IPC_CHANNELS.preference,
    (event, input: unknown) => {
      requireTrustedSender(options, event);
      return fixedAsyncResult(() => options.service.updatePreference(input));
    },
  );
  options.ipc.handle(AUTOMATIC_UPDATE_IPC_CHANNELS.check, (event) => {
    requireTrustedSender(options, event);
    return fixedResult(() => options.service.checkNow());
  });
  options.ipc.handle(AUTOMATIC_UPDATE_IPC_CHANNELS.install, (event) => {
    requireTrustedSender(options, event);
    return fixedResult(() => options.service.quitAndInstall());
  });
  return remove;
}
