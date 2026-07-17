import { describe, expect, it } from "vitest";

import {
  createCharacterIdleAnimation,
  type CharacterIdleVisibilitySource
} from "../src/public/animation.js";

class VisibilitySource
  extends EventTarget
  implements CharacterIdleVisibilitySource
{
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function classTarget(): {
  readonly classes: Set<string>;
  readonly target: Pick<Element, "classList">;
} {
  const classes = new Set<string>();
  return {
    classes,
    target: {
      classList: {
        toggle(name: string, force?: boolean): boolean {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        }
      } as DOMTokenList
    }
  };
}

describe("character idle animation lifecycle", () => {
  it("starts immediately and stops on demand", () => {
    const visibility = new VisibilitySource();
    const { classes, target } = classTarget();
    const animation = createCharacterIdleAnimation(target, visibility);

    animation.start();
    expect(animation.isRunning()).toBe(true);
    expect(classes.has("character-idle")).toBe(true);

    animation.stop();
    expect(animation.isRunning()).toBe(false);
    expect(classes.has("character-idle")).toBe(false);
  });

  it("pauses while hidden and resumes when visible", () => {
    const visibility = new VisibilitySource();
    const { classes, target } = classTarget();
    const animation = createCharacterIdleAnimation(target, visibility);
    animation.start();

    visibility.setVisibility("hidden");
    expect(animation.isRunning()).toBe(false);
    expect(classes.has("character-idle")).toBe(false);

    visibility.setVisibility("visible");
    expect(animation.isRunning()).toBe(true);
    expect(classes.has("character-idle")).toBe(true);
  });

  it("stays still for reduced motion and after destruction", () => {
    const visibility = new VisibilitySource();
    const reducedTarget = classTarget();
    const reduced = createCharacterIdleAnimation(
      reducedTarget.target,
      visibility,
      true
    );
    reduced.start();
    expect(reduced.isRunning()).toBe(false);
    expect(reducedTarget.classes.has("character-idle")).toBe(false);

    const regularTarget = classTarget();
    const regular = createCharacterIdleAnimation(
      regularTarget.target,
      visibility
    );
    regular.start();
    regular.destroy();
    visibility.setVisibility("hidden");
    visibility.setVisibility("visible");
    expect(regular.isRunning()).toBe(false);
    expect(regularTarget.classes.has("character-idle")).toBe(false);
  });
});
