export const LOCAL_SHARE_CARD_WIDTH = 1200 as const;
export const LOCAL_SHARE_CARD_HEIGHT = 630 as const;
export const LOCAL_SHARE_CARD_MIME_TYPE = "image/png" as const;
export const LOCAL_SHARE_CARD_FILENAME =
  "tokenmonster-local-share-card.png" as const;

const FONT_FAMILY =
  '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const FORMATTED_TOKEN_COUNT_PATTERN =
  /^(?:\d+|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?(?:[KMBTkmbt]|千|萬|万|億|亿|兆))$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;


export interface LocalShareCardPalette {
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
}

export interface LocalShareCardCharacter {
  readonly displayName: string;
  readonly glyph: string;
  readonly palette: LocalShareCardPalette;
  readonly themeLabel?: string;
}

export interface LocalShareCardCollection {
  readonly unlocked: number;
  readonly total: number;
}

export type LocalShareCardUsage28Days =
  | Readonly<{ readonly totalTokens: number }>
  | Readonly<{ readonly formattedTotal: string }>
  | Readonly<{ readonly hidden: true }>;

/**
 * Content-blind display data for a personal, on-device share card. Deliberately
 * absent are source/model identifiers, cost, content, and filesystem details.
 */
export interface LocalShareCardModel {
  readonly character: LocalShareCardCharacter;
  readonly collection: LocalShareCardCollection;
  readonly usage28Days: LocalShareCardUsage28Days;
  readonly mood?: string;
  readonly traitLabels?: readonly string[];
  readonly evolution?: string;
  readonly attribution?: string;
  readonly generatedAt: string;
}

export interface LocalShareCardTextMetrics {
  readonly width: number;
}

/** The small Canvas 2D surface used by the renderer and its Node tests. */
export interface LocalShareCardContext {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineWidth: number;
  beginPath(): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radii: number,
  ): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): LocalShareCardTextMetrics;
}

export interface LocalShareCardCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): LocalShareCardContext | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type: typeof LOCAL_SHARE_CARD_MIME_TYPE,
  ): void;
}

export interface LocalShareCardCanvasDocument {
  createElement(tagName: "canvas"): LocalShareCardCanvas;
}

export interface LocalShareCardRenderAdapters {
  /** A ready canvas takes precedence over document.createElement. */
  readonly canvas?: LocalShareCardCanvas;
  readonly document?: LocalShareCardCanvasDocument;
  /** Already-decoded local/cache image; this renderer never fetches one. */
  readonly characterImage?: Readonly<{
    readonly source: CanvasImageSource;
    readonly naturalWidth: number;
    readonly naturalHeight: number;
  }>;
}

export interface LocalShareCardDownloadAnchor {
  href: string;
  download: string;
  rel: string;
  click(): void;
}

export interface LocalShareCardDownloadDocument {
  createElement(tagName: "a"): LocalShareCardDownloadAnchor;
}

export interface LocalShareCardUrlAdapter {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface LocalShareCardDownloadAdapters {
  readonly document?: LocalShareCardDownloadDocument;
  readonly url?: LocalShareCardUrlAdapter;
}

export type TokenMonsterCompanionSavePngStatus =
  "saved" | "cancelled" | "already-exists" | "failed";

export interface TokenMonsterCompanionBridge {
  readonly savePng: (
    input: Readonly<{
      bytes: Uint8Array;
      suggestedName: typeof LOCAL_SHARE_CARD_FILENAME;
    }>,
  ) => Promise<Readonly<{ status: TokenMonsterCompanionSavePngStatus }>>;
  readonly getReminderStatus?: () => Promise<unknown>;
  readonly updateReminderSettings?: (input: Readonly<{
    expectedRevision: string;
    enabled: boolean;
    dailySummaryTime: string;
    quietHours: Readonly<{ start: string; end: string }>;
  }>) => Promise<unknown>;
  readonly testReminder?: () => Promise<unknown>;
  readonly getAutomaticUpdateStatus?: () => Promise<unknown>;
  readonly updateAutomaticChecks?: (input: Readonly<{
    expectedRevision: string;
    automaticChecksEnabled: boolean;
  }>) => Promise<unknown>;
  readonly checkForAutomaticUpdate?: () => Promise<unknown>;
  readonly installAutomaticUpdate?: () => Promise<unknown>;
}

declare global {
  interface Window {
    readonly tokenMonsterCompanion?: TokenMonsterCompanionBridge;
  }
}

export type LocalShareCardSaveStatus =
  TokenMonsterCompanionSavePngStatus | "download-started";

export interface LocalShareCardSaveAdapters extends LocalShareCardDownloadAdapters {
  /** null explicitly selects the browser fallback in tests and browser hosts. */
  readonly bridge?: TokenMonsterCompanionBridge | null;
}

function invalidModel(): never {
  throw new TypeError("Invalid local share card model");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExpectedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function parseBoundedText(value: unknown, maximumCodePoints: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    [...value].length > maximumCodePoints ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return invalidModel();
  }
  return value;
}

function parsePalette(value: unknown): LocalShareCardPalette {
  if (
    !isRecord(value) ||
    !hasExpectedKeys(value, ["background", "foreground", "accent"])
  ) {
    return invalidModel();
  }
  const background = value["background"];
  const foreground = value["foreground"];
  const accent = value["accent"];
  if (
    typeof background !== "string" ||
    typeof foreground !== "string" ||
    typeof accent !== "string" ||
    !HEX_COLOR_PATTERN.test(background) ||
    !HEX_COLOR_PATTERN.test(foreground) ||
    !HEX_COLOR_PATTERN.test(accent)
  ) {
    return invalidModel();
  }
  return Object.freeze({
    background: background.toLowerCase(),
    foreground: foreground.toLowerCase(),
    accent: accent.toLowerCase(),
  });
}

function parseCharacter(value: unknown): LocalShareCardCharacter {
  if (
    !isRecord(value) ||
    !hasExpectedKeys(value, ["displayName", "glyph", "palette"], ["themeLabel"])
  ) {
    return invalidModel();
  }
  const displayName = parseBoundedText(value["displayName"], 32);
  const glyph = parseBoundedText(value["glyph"], 4);
  const palette = parsePalette(value["palette"]);
  if ("themeLabel" in value) {
    return Object.freeze({
      displayName,
      glyph,
      palette,
      themeLabel: parseBoundedText(value["themeLabel"], 24),
    });
  }
  return Object.freeze({ displayName, glyph, palette });
}

function parseCollection(value: unknown): LocalShareCardCollection {
  if (!isRecord(value) || !hasExpectedKeys(value, ["unlocked", "total"])) {
    return invalidModel();
  }
  const unlocked = value["unlocked"];
  const total = value["total"];
  if (
    !Number.isSafeInteger(unlocked) ||
    !Number.isSafeInteger(total) ||
    (unlocked as number) < 0 ||
    (total as number) < 1 ||
    (total as number) > 100 ||
    (unlocked as number) > (total as number)
  ) {
    return invalidModel();
  }
  return Object.freeze({
    unlocked: unlocked as number,
    total: total as number,
  });
}

function parseUsage28Days(value: unknown): LocalShareCardUsage28Days {
  if (!isRecord(value)) return invalidModel();
  if (hasExpectedKeys(value, ["totalTokens"])) {
    const totalTokens = value["totalTokens"];
    if (!Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0) {
      return invalidModel();
    }
    return Object.freeze({ totalTokens: totalTokens as number });
  }
  if (hasExpectedKeys(value, ["formattedTotal"])) {
    const formattedTotal = parseBoundedText(value["formattedTotal"], 20);
    if (!FORMATTED_TOKEN_COUNT_PATTERN.test(formattedTotal)) {
      return invalidModel();
    }
    return Object.freeze({ formattedTotal });
  }
  if (hasExpectedKeys(value, ["hidden"]) && value["hidden"] === true) {
    return Object.freeze({ hidden: true });
  }
  return invalidModel();
}

function parseGeneratedAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return invalidModel();
  }
  return value;
}

/** Strictly validates and freezes the complete high-level display model. */
export function parseLocalShareCardModel(value: unknown): LocalShareCardModel {
  if (
    !isRecord(value) ||
    !hasExpectedKeys(
      value,
      ["character", "collection", "usage28Days", "generatedAt"],
      ["mood", "traitLabels", "evolution", "attribution"],
    )
  ) {
    return invalidModel();
  }

  const character = parseCharacter(value["character"]);
  const collection = parseCollection(value["collection"]);
  const usage28Days = parseUsage28Days(value["usage28Days"]);
  const generatedAt = parseGeneratedAt(value["generatedAt"]);
  const optional: {
    mood?: string;
    traitLabels?: readonly string[];
    evolution?: string;
    attribution?: string;
  } = {};

  if ("mood" in value) {
    optional.mood = parseBoundedText(value["mood"], 16);
  }
  if ("traitLabels" in value) {
    const traitLabels = value["traitLabels"];
    if (!Array.isArray(traitLabels) || traitLabels.length > 3) {
      return invalidModel();
    }
    const parsed = traitLabels.map((label) => parseBoundedText(label, 16));
    if (new Set(parsed).size !== parsed.length) return invalidModel();
    optional.traitLabels = Object.freeze(parsed);
  }
  if ("evolution" in value) {
    optional.evolution = parseBoundedText(value["evolution"], 20);
  }
  if ("attribution" in value) {
    optional.attribution = parseBoundedText(value["attribution"], 80);
  }

  return Object.freeze({
    character,
    collection,
    usage28Days,
    generatedAt,
    ...optional,
  });
}

function colorChannels(color: string): readonly [number, number, number] {
  return Object.freeze([
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ]);
}

function mixColor(base: string, target: string, targetRatio: number): string {
  const baseChannels = colorChannels(base);
  const targetChannels = colorChannels(target);
  const channel = (index: 0 | 1 | 2) =>
    Math.round(
      (baseChannels[index] ?? 0) * (1 - targetRatio) +
        (targetChannels[index] ?? 0) * targetRatio,
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function relativeLuminance(color: string): number {
  const channels = colorChannels(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableForeground(
  surface: string,
  preferred: string,
  alternate: string,
): string {
  return [preferred, alternate, "#17231f", "#ffffff"].reduce(
    (best, candidate) =>
      contrastRatio(surface, candidate) > contrastRatio(surface, best)
        ? candidate
        : best,
    preferred,
  );
}

function readableMuted(foreground: string, surface: string): string {
  return mixColor(foreground, surface, 0.2);
}

function setFont(
  context: LocalShareCardContext,
  weight: 500 | 600 | 700 | 800,
  size: number,
): void {
  context.font = `${weight} ${size}px ${FONT_FAMILY}`;
}

function roundedBox(
  context: LocalShareCardContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke?: string,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fillStyle = fill;
  context.fill();
  if (stroke !== undefined) {
    context.strokeStyle = stroke;
    context.lineWidth = 2;
    context.stroke();
  }
}

function fitText(
  context: LocalShareCardContext,
  text: string,
  maximumWidth: number,
): string {
  if (context.measureText(text).width <= maximumWidth) return text;
  const codePoints = [...text];
  while (codePoints.length > 1) {
    codePoints.pop();
    const candidate = `${codePoints.join("")}…`;
    if (context.measureText(candidate).width <= maximumWidth) return candidate;
  }
  return "…";
}

function usagePresentation(
  usage: LocalShareCardUsage28Days,
): Readonly<{ value: string; label: string }> {
  if ("hidden" in usage) {
    return Object.freeze({
      value: localizeUiText("由你保留"),
      label: localizeUiText("近 28 日總量未顯示"),
    });
  }
  return Object.freeze({
    value:
      "totalTokens" in usage
        ? formatUiNumber(usage.totalTokens, {
            notation: "compact",
            maximumFractionDigits: 1,
          })
        : usage.formattedTotal,
    label: localizeUiText("tokens・本機用量"),
  });
}

function profileChips(model: LocalShareCardModel): readonly string[] {
  const chips: string[] = [];
  if (model.mood !== undefined) {
    chips.push(localizeUiText(`心情　${model.mood}`));
  }
  for (const trait of model.traitLabels ?? []) {
    chips.push(localizeUiText(`特質　${trait}`));
  }
  if (model.evolution !== undefined) {
    chips.push(localizeUiText(`成長　${model.evolution}`));
  }
  return Object.freeze(chips);
}

function drawShareCard(
  context: LocalShareCardContext,
  model: LocalShareCardModel,
  characterImage?: LocalShareCardRenderAdapters["characterImage"],
): void {
  const { background, foreground, accent } = model.character.palette;
  const canvasBackground = mixColor(background, "#ffffff", 0.24);
  const surface = mixColor(background, "#ffffff", 0.72);
  const heroSurface = mixColor(background, accent, 0.12);
  const border = mixColor(background, accent, 0.42);
  const chipSurface = mixColor(background, "#ffffff", 0.5);
  const canvasForeground = readableForeground(
    canvasBackground,
    foreground,
    background,
  );
  const canvasMuted = readableMuted(canvasForeground, canvasBackground);
  const heroForeground = readableForeground(
    heroSurface,
    foreground,
    background,
  );
  const heroMuted = readableMuted(heroForeground, heroSurface);
  const surfaceForeground = readableForeground(surface, foreground, background);
  const surfaceMuted = readableMuted(surfaceForeground, surface);
  const usage = usagePresentation(model.usage28Days);

  context.fillStyle = canvasBackground;
  context.fillRect(0, 0, LOCAL_SHARE_CARD_WIDTH, LOCAL_SHARE_CARD_HEIGHT);

  context.beginPath();
  context.arc(1090, 10, 210, 0, Math.PI * 2);
  context.fillStyle = mixColor(background, accent, 0.28);
  context.fill();
  context.beginPath();
  context.arc(1138, 580, 132, 0, Math.PI * 2);
  context.fillStyle = mixColor(canvasBackground, accent, 0.16);
  context.fill();

  roundedBox(context, 52, 136, 480, 390, 36, heroSurface, border);
  roundedBox(context, 558, 136, 590, 390, 36, surface, border);

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = canvasForeground;
  setFont(context, 800, 34);
  context.fillText("TokenMonster", 64, 64);
  setFont(context, 600, 19);
  context.fillStyle = canvasMuted;
  context.fillText(localizeUiText("我的本機 AI 夥伴摘要"), 64, 100);
  context.textAlign = "right";
  context.fillText(`${model.generatedAt.slice(0, 10)} UTC`, 1136, 76);

  let imageDrawn = false;
  if (
    characterImage !== undefined &&
    Number.isSafeInteger(characterImage.naturalWidth) &&
    Number.isSafeInteger(characterImage.naturalHeight) &&
    characterImage.naturalWidth > 0 &&
    characterImage.naturalHeight > 0 &&
    characterImage.naturalWidth <= 8_192 &&
    characterImage.naturalHeight <= 8_192
  ) {
    const maximumWidth = 400;
    const maximumHeight = 272;
    const scale = Math.min(
      maximumWidth / characterImage.naturalWidth,
      maximumHeight / characterImage.naturalHeight,
    );
    const width = characterImage.naturalWidth * scale;
    const height = characterImage.naturalHeight * scale;
    try {
      context.drawImage(
        characterImage.source,
        292 - width / 2,
        151 + (maximumHeight - height) / 2,
        width,
        height,
      );
      imageDrawn = true;
    } catch {
      // A decoded image can still become unusable during a renderer teardown.
      // The deterministic glyph keeps sharing available without reloading it.
    }
  }
  if (!imageDrawn) {
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = heroForeground;
    setFont(context, 800, 210);
    context.fillText(model.character.glyph, 292, 319, 300);
  }

  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  setFont(context, 800, 42);
  context.fillText(fitText(context, model.character.displayName, 390), 92, 455);
  setFont(context, 600, 18);
  context.fillStyle = heroMuted;
  context.fillText(
    model.character.themeLabel === undefined
      ? localizeUiText("陪你一起看見每一次累積")
      : fitText(
          context,
          localizeUiText(`主題・${model.character.themeLabel}`),
          390,
        ),
    92,
    490,
  );

  context.fillStyle = surfaceMuted;
  setFont(context, 600, 18);
  context.fillText(localizeUiText("夥伴收藏"), 606, 190);
  context.fillText(localizeUiText("最近 28 個 UTC 日"), 858, 190);
  context.fillStyle = surfaceForeground;
  setFont(context, 800, 46);
  context.fillText(
    `${model.collection.unlocked} / ${model.collection.total}`,
    606,
    246,
  );
  context.fillText(fitText(context, usage.value, 235), 858, 246);
  context.fillStyle = surfaceMuted;
  setFont(context, 600, 16);
  context.fillText(localizeUiText("位已相遇夥伴"), 606, 278);
  context.fillText(usage.label, 858, 278);

  const chips = profileChips(model);
  context.fillStyle = surfaceForeground;
  setFont(context, 700, 19);
  context.fillText(localizeUiText("我的夥伴側寫"), 606, 317);

  if (chips.length === 0) {
    context.fillStyle = surfaceMuted;
    setFont(context, 500, 18);
    context.fillText(
      localizeUiText("每一次相遇，都只留在你的裝置裡。"),
      606,
      370,
    );
  } else {
    let x = 606;
    let y = 333;
    setFont(context, 600, 16);
    for (const chip of chips) {
      const label = fitText(context, chip, 196);
      const width = Math.min(context.measureText(label).width + 32, 232);
      if (x !== 606 && x + width > 1102) {
        x = 606;
        y += 44;
      }
      roundedBox(context, x, y, width, 36, 18, chipSurface, border);
      context.fillStyle = surfaceForeground;
      context.textBaseline = "middle";
      context.fillText(label, x + 16, y + 18);
      x += width + 10;
    }
  }

  if (model.attribution !== undefined) {
    context.textBaseline = "alphabetic";
    context.fillStyle = surfaceMuted;
    setFont(context, 500, 15);
    context.fillText(
      fitText(context, localizeUiText(`因為・${model.attribution}`), 496),
      606,
      500,
    );
  }

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = canvasMuted;
  setFont(context, 500, 16);
  context.fillText(
    localizeUiText("純本機個人摘要・不含對話內容・不代表全體 AI 使用"),
    64,
    590,
  );
}

function defaultCanvasDocument(): LocalShareCardCanvasDocument {
  if (typeof document === "undefined") {
    throw new Error("A canvas or document adapter is required");
  }
  return document as unknown as LocalShareCardCanvasDocument;
}

function encodePng(canvas: LocalShareCardCanvas): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob === null || blob.type !== LOCAL_SHARE_CARD_MIME_TYPE) {
          reject(new Error("Could not encode local share card as PNG"));
          return;
        }
        resolve(blob);
      }, LOCAL_SHARE_CARD_MIME_TYPE);
    } catch (error) {
      reject(
        new Error("Could not encode local share card as PNG", { cause: error }),
      );
    }
  });
}

/** Renders locally without fetching; an already-decoded cache image is optional. */
export async function renderLocalShareCard(
  value: unknown,
  adapters: LocalShareCardRenderAdapters = {},
): Promise<Blob> {
  const model = parseLocalShareCardModel(value);
  const canvas =
    adapters.canvas ??
    (adapters.document ?? defaultCanvasDocument()).createElement("canvas");
  canvas.width = LOCAL_SHARE_CARD_WIDTH;
  canvas.height = LOCAL_SHARE_CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2D is unavailable for the local share card");
  }
  drawShareCard(context, model, adapters.characterImage);
  return encodePng(canvas);
}

function defaultDownloadDocument(): LocalShareCardDownloadDocument {
  if (typeof document === "undefined") {
    throw new Error(
      "A document adapter is required to download the share card",
    );
  }
  return document as unknown as LocalShareCardDownloadDocument;
}

function defaultUrlAdapter(): LocalShareCardUrlAdapter {
  if (
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("A URL adapter is required to download the share card");
  }
  return URL;
}

/**
 * Downloads an already-rendered card. Object URLs exist only for the duration
 * of this explicit call and are revoked even when the synthetic click fails.
 */
export function downloadLocalShareCard(
  blob: Blob,
  adapters: LocalShareCardDownloadAdapters = {},
): void {
  if (blob.type !== LOCAL_SHARE_CARD_MIME_TYPE) {
    throw new TypeError("Local share card download requires a PNG Blob");
  }
  const downloadDocument = adapters.document ?? defaultDownloadDocument();
  const urlAdapter = adapters.url ?? defaultUrlAdapter();
  const anchor = downloadDocument.createElement("a");
  const objectUrl = urlAdapter.createObjectURL(blob);
  try {
    anchor.href = objectUrl;
    anchor.download = LOCAL_SHARE_CARD_FILENAME;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    urlAdapter.revokeObjectURL(objectUrl);
  }
}

function defaultCompanionBridge(): TokenMonsterCompanionBridge | null {
  return typeof window === "undefined"
    ? null
    : (window.tokenMonsterCompanion ?? null);
}

function isCompanionSaveStatus(
  value: unknown,
): value is TokenMonsterCompanionSavePngStatus {
  return (
    value === "saved" ||
    value === "cancelled" ||
    value === "already-exists" ||
    value === "failed"
  );
}

/**
 * Uses the Electron save bridge when present. A plain browser can only report
 * that its download flow was started; it must not claim the file was saved.
 */
export async function saveLocalShareCardBlob(
  blob: Blob,
  adapters: LocalShareCardSaveAdapters = {},
): Promise<Readonly<{ status: LocalShareCardSaveStatus }>> {
  if (blob.type !== LOCAL_SHARE_CARD_MIME_TYPE) {
    return Object.freeze({ status: "failed" });
  }
  const bridge =
    adapters.bridge === undefined ? defaultCompanionBridge() : adapters.bridge;
  if (bridge !== null) {
    try {
      const result = await bridge.savePng({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        suggestedName: LOCAL_SHARE_CARD_FILENAME,
      });
      if (
        !isRecord(result) ||
        !hasExpectedKeys(result, ["status"]) ||
        !isCompanionSaveStatus(result["status"])
      ) {
        return Object.freeze({ status: "failed" });
      }
      return Object.freeze({ status: result["status"] });
    } catch {
      return Object.freeze({ status: "failed" });
    }
  }
  try {
    downloadLocalShareCard(blob, adapters);
    return Object.freeze({ status: "download-started" });
  } catch {
    return Object.freeze({ status: "failed" });
  }
}
import { formatUiNumber, localizeUiText } from "./localization.js";
