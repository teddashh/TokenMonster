export const CHARACTER_ANIMATION_CLASSES = Object.freeze([
  "character-idle",
  "character-letter-idle",
  "character-entering",
  "character-crossfade-in",
  "character-crossfade-out"
] as const);

export type CharacterAnimationClass =
  (typeof CHARACTER_ANIMATION_CLASSES)[number];

export function enabledCharacterAnimationClasses(
  reducedMotion: boolean
): readonly CharacterAnimationClass[] {
  return reducedMotion ? Object.freeze([]) : CHARACTER_ANIMATION_CLASSES;
}

export interface PortraitTarget {
  readonly characterId: string;
  readonly imagePath: string;
}

export interface PortraitSwitchHooks<T extends PortraitTarget> {
  preload(imagePath: string): Promise<void>;
  onSwitching(target: T, current: T | undefined): void;
  onCommit(target: T, current: T | undefined): void;
  onError(target: T, current: T | undefined): void;
}

export interface PortraitSwitchStateMachine<T extends PortraitTarget> {
  current(): T | undefined;
  transition(target: T): Promise<boolean>;
  cancel(): void;
}

/** Keeps the committed portrait unchanged until its successor is decoded. */
export function createPortraitSwitchStateMachine<T extends PortraitTarget>(
  hooks: PortraitSwitchHooks<T>
): PortraitSwitchStateMachine<T> {
  let committed: T | undefined;
  let sequence = 0;
  return Object.freeze({
    current(): T | undefined {
      return committed;
    },
    async transition(target: T): Promise<boolean> {
      const transitionSequence = ++sequence;
      hooks.onSwitching(target, committed);
      try {
        await hooks.preload(target.imagePath);
      } catch {
        if (sequence === transitionSequence) hooks.onError(target, committed);
        return false;
      }
      if (sequence !== transitionSequence) return false;
      const previous = committed;
      committed = target;
      hooks.onCommit(target, previous);
      return true;
    },
    cancel(): void {
      sequence += 1;
      committed = undefined;
    }
  });
}

export type CharacterImageFactory = () => HTMLImageElement;

export async function preloadCharacterImage(
  imagePath: string,
  createImage: CharacterImageFactory = () => new Image()
): Promise<void> {
  const image = createImage();
  const loaded = new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Character image unavailable")),
      { once: true }
    );
  });
  image.src = imagePath;
  await loaded;
  if (typeof image.decode === "function") await image.decode();
}

export function userPrefersReducedMotion(
  matchMedia: Pick<Window, "matchMedia"> = window
): boolean {
  return matchMedia.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
