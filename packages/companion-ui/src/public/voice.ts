import type { CharacterId, VoiceTrigger } from "./dto.js";

export interface VoicePreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VoicePlaybackGate {
  arm(): void;
  isArmed(): boolean;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  allow(trigger: VoiceTrigger, characterId: CharacterId, now: number): boolean;
}

export function createVoicePlaybackGate(
  storage: VoicePreferenceStorage
): VoicePlaybackGate {
  let armed = false;
  let enabled = false;
  try {
    enabled = storage.getItem("tokenmonster-voice") === "on";
  } catch {
    enabled = false;
  }
  const greetedCharacters = new Set<CharacterId>();
  const hourlyTriggers = new Map<string, number>();
  return Object.freeze({
    arm(): void {
      armed = true;
    },
    isArmed(): boolean {
      return armed;
    },
    isEnabled(): boolean {
      return enabled;
    },
    setEnabled(nextEnabled: boolean): void {
      enabled = nextEnabled;
      try {
        storage.setItem(
          "tokenmonster-voice",
          nextEnabled ? "on" : "off"
        );
      } catch {
        // A blocked storage area only makes this preference session-local.
      }
    },
    allow(
      trigger: VoiceTrigger,
      characterId: CharacterId,
      now: number
    ): boolean {
      if (!armed || !enabled) return false;
      if (trigger === "greeting") {
        if (greetedCharacters.has(characterId)) return false;
        greetedCharacters.add(characterId);
        return true;
      }
      if (trigger === "quiet" || trigger === "active") {
        const key = trigger;
        const lastPlayedAt = hourlyTriggers.get(key);
        if (lastPlayedAt !== undefined && now - lastPlayedAt < 3_600_000) {
          return false;
        }
        hourlyTriggers.set(key, now);
      }
      return true;
    }
  });
}


