const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");
const {
  COMPANION_PNG_SAVE_CHANNEL,
  COMPANION_PNG_SUGGESTED_NAME,
  copyCompanionShareCardPng,
  isCompanionPlainRecord,
  isCompanionPngSaveResponse
}: typeof import("../shared/companion-png.js") = require("../shared/companion-png.js");
const {
  REMINDER_IPC_CHANNELS,
  parseReminderMutationResult,
  parseReminderServiceStatus,
  parseReminderSettingsRequest,
  parseReminderTestResult
}: typeof import("../shared/reminders.js") = require("../shared/reminders.js");
const {
  AUTOMATIC_UPDATE_IPC_CHANNELS,
  parseAutomaticUpdatePreferenceMutationResult,
  parseAutomaticUpdatePreferenceRequest,
  parseAutomaticUpdateServiceCommandResult,
  parseAutomaticUpdateServiceStatus
}: typeof import("../shared/automatic-updates.js") = require("../shared/automatic-updates.js");

import type {
  CompanionPngSaveRequest,
  TokenMonsterCompanionBridge
} from "../shared/companion-png.js";
import type { ReminderSettingsRequest } from "../shared/reminders.js";
import type { AutomaticUpdatePreferenceRequest } from "../shared/automatic-updates.js";

function plainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return isCompanionPlainRecord(value);
}

function parseRequest(value: unknown): CompanionPngSaveRequest {
  if (!plainRecord(value)) throw new Error("IPC_REQUEST_REJECTED");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("bytes") ||
    !keys.includes("suggestedName")
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  const bytesDescriptor = Object.getOwnPropertyDescriptor(value, "bytes");
  const nameDescriptor = Object.getOwnPropertyDescriptor(
    value,
    "suggestedName"
  );
  const bytes =
    bytesDescriptor === undefined || !("value" in bytesDescriptor)
      ? null
      : copyCompanionShareCardPng(bytesDescriptor.value);
  if (
    bytesDescriptor === undefined ||
    !("value" in bytesDescriptor) ||
    nameDescriptor === undefined ||
    !("value" in nameDescriptor) ||
    nameDescriptor.value !== COMPANION_PNG_SUGGESTED_NAME ||
    bytes === null
  ) {
    throw new Error("IPC_REQUEST_REJECTED");
  }
  return {
    bytes,
    suggestedName: COMPANION_PNG_SUGGESTED_NAME
  };
}

let saveInFlight = false;
let reminderMutationInFlight = false;
let automaticUpdateCommandInFlight = false;
const bridge: TokenMonsterCompanionBridge = Object.freeze({
  async savePng(request: CompanionPngSaveRequest) {
    if (saveInFlight) throw new Error("IPC_REQUEST_BUSY");
    const parsed = parseRequest(request);
    saveInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        COMPANION_PNG_SAVE_CHANNEL,
        parsed
      )) as unknown;
      if (!isCompanionPngSaveResponse(response)) {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
      return Object.freeze({ status: response.status });
    } finally {
      saveInFlight = false;
    }
  },
  async getReminderStatus() {
    const response = (await ipcRenderer.invoke(
      REMINDER_IPC_CHANNELS.status
    )) as unknown;
    try {
      return parseReminderServiceStatus(response);
    } catch {
      throw new Error("IPC_RESPONSE_REJECTED");
    }
  },
  async updateReminderSettings(request: ReminderSettingsRequest) {
    if (reminderMutationInFlight) throw new Error("IPC_REQUEST_BUSY");
    let parsed: ReturnType<typeof parseReminderSettingsRequest>;
    try {
      parsed = parseReminderSettingsRequest(request);
    } catch {
      throw new Error("IPC_REQUEST_REJECTED");
    }
    reminderMutationInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        REMINDER_IPC_CHANNELS.update,
        parsed
      )) as unknown;
      try {
        return parseReminderMutationResult(response);
      } catch {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
    } finally {
      reminderMutationInFlight = false;
    }
  },
  async testReminder() {
    if (reminderMutationInFlight) throw new Error("IPC_REQUEST_BUSY");
    reminderMutationInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        REMINDER_IPC_CHANNELS.test
      )) as unknown;
      try {
        return parseReminderTestResult(response);
      } catch {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
    } finally {
      reminderMutationInFlight = false;
    }
  },
  async getAutomaticUpdateStatus() {
    const response = (await ipcRenderer.invoke(
      AUTOMATIC_UPDATE_IPC_CHANNELS.status
    )) as unknown;
    try {
      return parseAutomaticUpdateServiceStatus(response);
    } catch {
      throw new Error("IPC_RESPONSE_REJECTED");
    }
  },
  async updateAutomaticChecks(request: AutomaticUpdatePreferenceRequest) {
    if (automaticUpdateCommandInFlight) throw new Error("IPC_REQUEST_BUSY");
    let parsed: ReturnType<typeof parseAutomaticUpdatePreferenceRequest>;
    try {
      parsed = parseAutomaticUpdatePreferenceRequest(request);
    } catch {
      throw new Error("IPC_REQUEST_REJECTED");
    }
    automaticUpdateCommandInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        AUTOMATIC_UPDATE_IPC_CHANNELS.preference,
        parsed
      )) as unknown;
      try {
        return parseAutomaticUpdatePreferenceMutationResult(response);
      } catch {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
    } finally {
      automaticUpdateCommandInFlight = false;
    }
  },
  async checkForAutomaticUpdate() {
    if (automaticUpdateCommandInFlight) throw new Error("IPC_REQUEST_BUSY");
    automaticUpdateCommandInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        AUTOMATIC_UPDATE_IPC_CHANNELS.check
      )) as unknown;
      try {
        return parseAutomaticUpdateServiceCommandResult(response);
      } catch {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
    } finally {
      automaticUpdateCommandInFlight = false;
    }
  },
  async installAutomaticUpdate() {
    if (automaticUpdateCommandInFlight) throw new Error("IPC_REQUEST_BUSY");
    automaticUpdateCommandInFlight = true;
    try {
      const response = (await ipcRenderer.invoke(
        AUTOMATIC_UPDATE_IPC_CHANNELS.install
      )) as unknown;
      try {
        return parseAutomaticUpdateServiceCommandResult(response);
      } catch {
        throw new Error("IPC_RESPONSE_REJECTED");
      }
    } finally {
      automaticUpdateCommandInFlight = false;
    }
  }
});

contextBridge.exposeInMainWorld("tokenMonsterCompanion", bridge);
