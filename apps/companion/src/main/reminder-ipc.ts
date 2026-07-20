import type { IpcMain, IpcMainInvokeEvent } from "electron";

import type { ReminderService } from "./reminder-service.js";
import { REMINDER_IPC_CHANNELS } from "../shared/reminders.js";

export interface ReminderIpcOptions {
  readonly ipc: Pick<IpcMain, "handle" | "removeHandler">;
  readonly service: ReminderService;
  readonly trustedSender: (event: IpcMainInvokeEvent) => boolean;
}

function requireTrustedSender(
  options: ReminderIpcOptions,
  event: IpcMainInvokeEvent,
): void {
  if (!options.trustedSender(event)) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
}

/** Install the fixed reminder surface. It exposes no generic gateway or
 * filesystem operation and delegates all persistence to ReminderService. */
export function registerReminderIpcHandlers(
  options: ReminderIpcOptions,
): () => void {
  const remove = (): void => {
    for (const channel of Object.values(REMINDER_IPC_CHANNELS)) {
      options.ipc.removeHandler(channel);
    }
  };
  remove();
  options.ipc.handle(REMINDER_IPC_CHANNELS.status, (event) => {
    requireTrustedSender(options, event);
    return options.service.status();
  });
  options.ipc.handle(REMINDER_IPC_CHANNELS.update, (event, input: unknown) => {
    requireTrustedSender(options, event);
    return options.service.updateSettings(input);
  });
  options.ipc.handle(REMINDER_IPC_CHANNELS.test, (event) => {
    requireTrustedSender(options, event);
    return options.service.testNotification();
  });
  return remove;
}
