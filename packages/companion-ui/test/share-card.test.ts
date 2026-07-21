import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_SHARE_CARD_FILENAME,
  LOCAL_SHARE_CARD_HEIGHT,
  LOCAL_SHARE_CARD_MIME_TYPE,
  LOCAL_SHARE_CARD_WIDTH,
  downloadLocalShareCard,
  parseLocalShareCardModel,
  renderLocalShareCard,
  saveLocalShareCardBlob,
  type LocalShareCardCanvas,
  type LocalShareCardContext,
  type LocalShareCardModel,
  type TokenMonsterCompanionBridge,
} from "../src/public/share-card.js";
import { setUiLocale } from "../src/public/localization.js";

interface DrawOperation {
  readonly operation: string;
  readonly arguments: readonly (number | string)[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly font: string;
  readonly textAlign: CanvasTextAlign;
  readonly textBaseline: CanvasTextBaseline;
}

interface FakeCanvas {
  readonly canvas: LocalShareCardCanvas;
  readonly operations: readonly DrawOperation[];
  readonly requestedTypes: readonly string[];
}

const pngBlob = () => new Blob(["local-card"], { type: "image/png" });

function validModel(): LocalShareCardModel {
  return {
    character: {
      displayName: "小怪獸 Claude",
      glyph: "C",
      palette: {
        background: "#F7E5D5",
        foreground: "#553323",
        accent: "#C47C55",
      },
      themeLabel: "午後茶會",
    },
    collection: { unlocked: 4, total: 11 },
    usage28Days: { totalTokens: 1_234_567 },
    mood: "專注",
    traitLabels: ["長篇思考", "快取好朋友"],
    evolution: "默契萌芽",
    attribution: "近 28 天的工具使用較集中在命令列介面。",
    generatedAt: "2026-07-17T18:24:00.000Z",
  };
}

function createFakeContext(operations: DrawOperation[]): LocalShareCardContext {
  const context: LocalShareCardContext = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineWidth: 1,
    beginPath() {
      record("beginPath", []);
    },
    arc(x, y, radius, startAngle, endAngle) {
      record("arc", [x, y, radius, startAngle, endAngle]);
    },
    roundRect(x, y, width, height, radii) {
      record("roundRect", [x, y, width, height, radii]);
    },
    fill() {
      record("fill", []);
    },
    stroke() {
      record("stroke", []);
    },
    fillRect(x, y, width, height) {
      record("fillRect", [x, y, width, height]);
    },
    drawImage(_image, dx, dy, dWidth, dHeight) {
      record("drawImage", [dx, dy, dWidth, dHeight]);
    },
    fillText(text, x, y, maxWidth) {
      record("fillText", [
        text,
        x,
        y,
        ...(maxWidth === undefined ? [] : [maxWidth]),
      ]);
    },
    measureText(text) {
      return { width: [...text].length * 11 };
    },
  };

  function record(
    operation: string,
    arguments_: readonly (number | string)[],
  ): void {
    operations.push({
      operation,
      arguments: arguments_,
      fillStyle: context.fillStyle,
      strokeStyle: context.strokeStyle,
      font: context.font,
      textAlign: context.textAlign,
      textBaseline: context.textBaseline,
    });
  }

  return context;
}

function createFakeCanvas(
  encode: (callback: (blob: Blob | null) => void, type: string) => void = (
    callback,
  ) => callback(pngBlob()),
  contextAvailable = true,
): FakeCanvas {
  const operations: DrawOperation[] = [];
  const requestedTypes: string[] = [];
  const context = createFakeContext(operations);
  const canvas: LocalShareCardCanvas = {
    width: 0,
    height: 0,
    getContext: () => (contextAvailable ? context : null),
    toBlob(callback, type) {
      requestedTypes.push(type);
      encode(callback, type);
    },
  };
  return { canvas, operations, requestedTypes };
}

afterEach(() => {
  setUiLocale("zh-TW");
  vi.unstubAllGlobals();
});

describe("local share card display model", () => {
  it("renders the complete English card without Han copy", async () => {
    setUiLocale("en");
    const rendered = createFakeCanvas();
    await renderLocalShareCard(
      {
        ...validModel(),
        character: {
          ...validModel().character,
          displayName: "Claude",
          themeLabel: "Technology",
        },
        mood: "Steady",
        traitLabels: ["CLI focused", "Cache rhythm"],
        evolution: "First profile",
        attribution: "Based on available local daily data.",
      },
      { canvas: rendered.canvas },
    );
    const text = rendered.operations
      .filter(({ operation }) => operation === "fillText")
      .map(({ arguments: [value] }) => String(value));
    expect(text.length).toBeGreaterThan(10);
    expect(text.join("\n")).not.toMatch(/\p{Script=Han}/u);
  });

  it("accepts only bounded high-level display data and freezes it", () => {
    const parsed = parseLocalShareCardModel(validModel());

    expect(parsed.character.palette).toEqual({
      background: "#f7e5d5",
      foreground: "#553323",
      accent: "#c47c55",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.character)).toBe(true);
    expect(Object.isFrozen(parsed.character.palette)).toBe(true);
    expect(Object.isFrozen(parsed.traitLabels)).toBe(true);
  });

  it("accepts a short preformatted 28-day total", () => {
    const model = {
      ...validModel(),
      usage28Days: { formattedTotal: "12.3萬" },
    };

    expect(parseLocalShareCardModel(model).usage28Days).toEqual({
      formattedTotal: "12.3萬",
    });
  });

  it("accepts an explicit player choice to hide the 28-day total", () => {
    const model = {
      ...validModel(),
      usage28Days: { hidden: true },
    };

    expect(parseLocalShareCardModel(model).usage28Days).toEqual({
      hidden: true,
    });
  });

  it("rejects unknown fields at every privacy-sensitive boundary", () => {
    const base = validModel();
    const invalid = [
      { ...base, rawSource: "claude-code" },
      {
        ...base,
        character: { ...base.character, model: "private-model-name" },
      },
      {
        ...base,
        collection: { ...base.collection, projectPath: "/private/project" },
      },
      {
        ...base,
        usage28Days: { totalTokens: 1, cost: 9.99 },
      },
      { ...base, usage28Days: { hidden: false } },
      { ...base, usage28Days: { hidden: true, totalTokens: 1 } },
    ];

    for (const candidate of invalid) {
      expect(() => parseLocalShareCardModel(candidate)).toThrow(
        "Invalid local share card model",
      );
    }
  });

  it("rejects out-of-bounds text, collections, traits, totals, and timestamps", () => {
    const base = validModel();
    const invalid = [
      {
        ...base,
        character: { ...base.character, displayName: "名".repeat(33) },
      },
      { ...base, character: { ...base.character, glyph: "ABCDE" } },
      { ...base, collection: { unlocked: 12, total: 11 } },
      { ...base, collection: { unlocked: 1, total: 101 } },
      {
        ...base,
        usage28Days: { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...base, usage28Days: { formattedTotal: "about a million" } },
      { ...base, traitLabels: ["一", "二", "三", "四"] },
      { ...base, traitLabels: ["重複", "重複"] },
      { ...base, attribution: "太長".repeat(41) },
      { ...base, generatedAt: "2026-07-17T18:24:00+00:00" },
    ];

    for (const candidate of invalid) {
      expect(() => parseLocalShareCardModel(candidate)).toThrow(TypeError);
    }
  });
});

describe("local share card renderer", () => {
  it("draws a deterministic 1200x630 finished card in stable content order", async () => {
    const first = createFakeCanvas();
    const second = createFakeCanvas();

    const result = await renderLocalShareCard(validModel(), {
      canvas: first.canvas,
    });
    await renderLocalShareCard(validModel(), { canvas: second.canvas });

    expect(result.type).toBe(LOCAL_SHARE_CARD_MIME_TYPE);
    expect(first.canvas.width).toBe(LOCAL_SHARE_CARD_WIDTH);
    expect(first.canvas.height).toBe(LOCAL_SHARE_CARD_HEIGHT);
    expect(first.requestedTypes).toEqual([LOCAL_SHARE_CARD_MIME_TYPE]);
    expect(first.operations).toEqual(second.operations);
    expect(first.operations[0]).toMatchObject({
      operation: "fillRect",
      arguments: [0, 0, 1200, 630],
    });

    const texts = first.operations
      .filter(({ operation }) => operation === "fillText")
      .map(({ arguments: [text] }) => text);
    expect(texts).toEqual([
      "TokenMonster",
      "我的本機 AI 夥伴摘要",
      "2026-07-17 UTC",
      "C",
      "小怪獸 Claude",
      "主題・午後茶會",
      "夥伴收藏",
      "最近 28 個 UTC 日",
      "4 / 11",
      "123.5萬",
      "位已相遇夥伴",
      "tokens・本機用量",
      "我的夥伴側寫",
      "心情　專注",
      "特質　長篇思考",
      "特質　快取好朋友",
      "成長　默契萌芽",
      "因為・近 28 天的工具使用較集中在命令列介面。",
      "純本機個人摘要・不含對話內容・不代表全體 AI 使用",
    ]);
  });

  it("renders a clear omission instead of a token number when the player hides it", async () => {
    const rendered = createFakeCanvas();

    await renderLocalShareCard(
      { ...validModel(), usage28Days: { hidden: true } },
      { canvas: rendered.canvas },
    );

    const texts = rendered.operations
      .filter(({ operation }) => operation === "fillText")
      .map(({ arguments: [text] }) => text);
    expect(texts).toContain("由你保留");
    expect(texts).toContain("近 28 日總量未顯示");
    expect(texts).not.toContain("123.5萬");
  });

  it("keeps information text readable when the selected theme uses light text on a dark hero", async () => {
    const rendered = createFakeCanvas();
    const darkTheme = {
      ...validModel(),
      character: {
        ...validModel().character,
        palette: {
          background: "#164c3d",
          foreground: "#f7f9f8",
          accent: "#53b894",
        },
      },
    };

    await renderLocalShareCard(darkTheme, { canvas: rendered.canvas });

    const rightPanelLabel = rendered.operations.find(
      ({ operation, arguments: [text] }) =>
        operation === "fillText" && text === "夥伴收藏",
    );
    const rightPanelTotal = rendered.operations.find(
      ({ operation, arguments: [text] }) =>
        operation === "fillText" && text === "4 / 11",
    );
    expect(rightPanelLabel?.fillStyle).not.toBe("#f7f9f8");
    expect(rightPanelTotal?.fillStyle).not.toBe("#f7f9f8");
    expect(rightPanelLabel?.fillStyle).not.toBe(rightPanelTotal?.fillStyle);
  });

  it("can create the canvas through an injected document adapter", async () => {
    const fake = createFakeCanvas();
    const createElement = vi.fn(() => fake.canvas);

    await renderLocalShareCard(validModel(), {
      document: { createElement },
    });

    expect(createElement).toHaveBeenCalledOnce();
    expect(createElement).toHaveBeenCalledWith("canvas");
  });

  it("does not fetch, construct Image, or create an object URL while rendering", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    let imageConstructed = false;
    class ForbiddenImage {
      constructor() {
        imageConstructed = true;
        throw new Error("Image must not be constructed");
      }
    }
    const createObjectURL = vi.fn(() => {
      throw new Error("URL must not be created while rendering");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Image", ForbiddenImage);
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });

    await renderLocalShareCard(validModel(), {
      canvas: createFakeCanvas().canvas,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageConstructed).toBe(false);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("draws an already-decoded local character image without constructing or fetching one", async () => {
    const rendered = createFakeCanvas();
    const source = {} as CanvasImageSource;
    const fetchMock = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    const imageConstructor = vi.fn(() => {
      throw new Error("Image must not be constructed");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Image", imageConstructor);

    await renderLocalShareCard(validModel(), {
      canvas: rendered.canvas,
      characterImage: {
        source,
        naturalWidth: 600,
        naturalHeight: 800,
      },
    });

    expect(
      rendered.operations.filter(({ operation }) => operation === "drawImage"),
    ).toHaveLength(1);
    expect(
      rendered.operations.some(
        ({ operation, arguments: [text] }) =>
          operation === "fillText" && text === "C",
      ),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageConstructor).not.toHaveBeenCalled();
  });

  it("falls back to the glyph when a supplied image is not drawable", async () => {
    const rendered = createFakeCanvas();

    await renderLocalShareCard(validModel(), {
      canvas: rendered.canvas,
      characterImage: {
        source: {} as CanvasImageSource,
        naturalWidth: 0,
        naturalHeight: 800,
      },
    });

    expect(
      rendered.operations.some(
        ({ operation, arguments: [text] }) =>
          operation === "fillText" && text === "C",
      ),
    ).toBe(true);
    expect(
      rendered.operations.some(({ operation }) => operation === "drawImage"),
    ).toBe(false);
  });

  it("rejects a null or non-PNG encoder result", async () => {
    const nullResult = createFakeCanvas((callback) => callback(null));
    const wrongType = createFakeCanvas((callback) =>
      callback(new Blob(["wrong"], { type: "image/jpeg" })),
    );

    await expect(
      renderLocalShareCard(validModel(), { canvas: nullResult.canvas }),
    ).rejects.toThrow("Could not encode local share card as PNG");
    await expect(
      renderLocalShareCard(validModel(), { canvas: wrongType.canvas }),
    ).rejects.toThrow("Could not encode local share card as PNG");
  });

  it("normalizes a synchronous encoder error", async () => {
    const failed = createFakeCanvas(() => {
      throw new Error("platform encoder details");
    });

    await expect(
      renderLocalShareCard(validModel(), { canvas: failed.canvas }),
    ).rejects.toThrow("Could not encode local share card as PNG");
  });

  it("fails explicitly when Canvas 2D is unavailable", async () => {
    const failed = createFakeCanvas(undefined, false);

    await expect(
      renderLocalShareCard(validModel(), { canvas: failed.canvas }),
    ).rejects.toThrow("Canvas 2D is unavailable");
  });
});

describe("explicit local share card download", () => {
  it.each(["saved", "cancelled", "already-exists", "failed"] as const)(
    "reports the Electron bridge %s result exactly",
    async (status) => {
      const inputs: Parameters<TokenMonsterCompanionBridge["savePng"]>[0][] =
        [];
      const savePng: TokenMonsterCompanionBridge["savePng"] = vi.fn(
        async (input) => {
          inputs.push(input);
          return { status };
        },
      );

      await expect(
        saveLocalShareCardBlob(pngBlob(), { bridge: { savePng } }),
      ).resolves.toEqual({ status });
      expect(savePng).toHaveBeenCalledOnce();
      expect(savePng).toHaveBeenCalledWith({
        bytes: expect.any(Uint8Array),
        suggestedName: LOCAL_SHARE_CARD_FILENAME,
      });
      expect(new TextDecoder().decode(inputs[0]?.bytes)).toBe("local-card");
    },
  );

  it("normalizes a rejected or malformed Electron save result to failed", async () => {
    const malformed = vi.fn(async () => ({ status: "unexpected" }));
    const rejected = vi.fn(async () => {
      throw new Error("native details");
    });

    await expect(
      saveLocalShareCardBlob(pngBlob(), {
        bridge: malformed as never,
      }),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      saveLocalShareCardBlob(pngBlob(), { bridge: { savePng: rejected } }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("only reports download-started for the plain-browser fallback", async () => {
    const click = vi.fn();
    const revokeObjectURL = vi.fn();

    await expect(
      saveLocalShareCardBlob(pngBlob(), {
        bridge: null,
        document: {
          createElement: () => ({
            href: "",
            download: "",
            rel: "",
            click,
          }),
        },
        url: {
          createObjectURL: () => "blob:browser-card",
          revokeObjectURL,
        },
      }),
    ).resolves.toEqual({ status: "download-started" });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:browser-card");
  });

  it("clicks a fixed-name download and immediately revokes its object URL", () => {
    const lifecycle: string[] = [];
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(() => lifecycle.push("click")),
    };
    const url = {
      createObjectURL: vi.fn(() => {
        lifecycle.push("create");
        return "blob:local-share-card";
      }),
      revokeObjectURL: vi.fn((value: string) =>
        lifecycle.push(`revoke:${value}`),
      ),
    };

    downloadLocalShareCard(pngBlob(), {
      document: { createElement: vi.fn(() => anchor) },
      url,
    });

    expect(anchor).toMatchObject({
      href: "blob:local-share-card",
      download: LOCAL_SHARE_CARD_FILENAME,
      rel: "noopener",
    });
    expect(lifecycle).toEqual([
      "create",
      "click",
      "revoke:blob:local-share-card",
    ]);
  });

  it("revokes the object URL even when the synthetic click fails", () => {
    const revokeObjectURL = vi.fn();
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: () => {
        throw new Error("click failed");
      },
    };

    expect(() =>
      downloadLocalShareCard(pngBlob(), {
        document: { createElement: () => anchor },
        url: {
          createObjectURL: () => "blob:temporary",
          revokeObjectURL,
        },
      }),
    ).toThrow("click failed");
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:temporary");
  });

  it("rejects a non-PNG Blob before creating an object URL", () => {
    const createObjectURL = vi.fn(() => "blob:wrong");

    expect(() =>
      downloadLocalShareCard(new Blob(["wrong"], { type: "text/plain" }), {
        document: {
          createElement: () => ({
            href: "",
            download: "",
            rel: "",
            click: vi.fn(),
          }),
        },
        url: { createObjectURL, revokeObjectURL: vi.fn() },
      }),
    ).toThrow("requires a PNG Blob");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
