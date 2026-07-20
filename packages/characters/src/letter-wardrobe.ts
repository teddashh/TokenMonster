import { z } from "zod";

import {
  WARDROBE_THEME_IDS,
  WardrobeThemeIdSchema,
  type WardrobeThemeId,
} from "./progression.js";

export const LETTER_WARDROBE_PATTERN_IDS = [
  "circuit-grid",
  "ledger-grid",
  "civic-ribbons",
  "notebook-lines",
  "pulse-steps",
  "leaf-canopy",
  "balanced-scales",
  "interlocking-rings",
  "woven-home",
  "checklist-grid",
  "constellation",
  "story-weave",
  "speed-stripes",
  "table-check",
  "route-dashes",
  "soft-waves",
  "nested-circles",
  "linked-arcs",
  "broadcast-rings",
  "confetti",
] as const;

export type LetterWardrobePatternId =
  (typeof LETTER_WARDROBE_PATTERN_IDS)[number];
export const LetterWardrobePatternIdSchema = z.enum(
  LETTER_WARDROBE_PATTERN_IDS,
);

export const LETTER_WARDROBE_ACCENT_IDS = [
  "terminal-caret",
  "steady-coin",
  "dialogue-star",
  "open-book",
  "care-cross",
  "new-leaf",
  "law-seal",
  "listening-knot",
  "home-heart",
  "task-check",
  "research-spark",
  "story-mark",
  "victory-chevron",
  "shared-plate",
  "compass-point",
  "reflection-orbit",
  "question-ring",
  "world-link",
  "signal-dot",
  "celebration-star",
] as const;

export type LetterWardrobeAccentId =
  (typeof LETTER_WARDROBE_ACCENT_IDS)[number];
export const LetterWardrobeAccentIdSchema = z.enum(
  LETTER_WARDROBE_ACCENT_IDS,
);

const HexColorSchema = z.string().regex(/^#[0-9A-F]{6}$/u);

const PaletteSchema = z
  .object({
    background: HexColorSchema,
    foreground: HexColorSchema,
    accent: HexColorSchema,
  })
  .strict();

const PatternSchema = z
  .object({
    id: LetterWardrobePatternIdSchema,
    label: z.string().min(1).max(60),
    density: z.enum(["light", "medium", "bold"]),
  })
  .strict();

const AccentSchema = z
  .object({
    id: LetterWardrobeAccentIdSchema,
    label: z.string().min(1).max(60),
    placement: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
  })
  .strict();

function relativeLuminance(hexColor: string): number {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/gu)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return (
    0.2126 * channels[0]! +
    0.7152 * channels[1]! +
    0.0722 * channels[2]!
  );
}

function contrastRatio(left: string, right: string): number {
  const brightest = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darkest = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (brightest + 0.05) / (darkest + 0.05);
}

export const LetterWardrobeThemeSchema = z
  .object({
    themeId: WardrobeThemeIdSchema,
    displayName: z.string().min(1).max(40),
    accessibleLabel: z.string().min(1).max(120),
    palette: PaletteSchema,
    pattern: PatternSchema,
    accent: AccentSchema,
  })
  .strict()
  .superRefine((theme, context) => {
    if (contrastRatio(theme.palette.background, theme.palette.foreground) < 7) {
      context.addIssue({
        code: "custom",
        path: ["palette", "foreground"],
        message: "Letter foreground must have at least 7:1 background contrast.",
      });
    }
    if (contrastRatio(theme.palette.background, theme.palette.accent) < 4.5) {
      context.addIssue({
        code: "custom",
        path: ["palette", "accent"],
        message: "Pattern/accent color must have at least 4.5:1 background contrast.",
      });
    }
  });

export type LetterWardrobeTheme = Readonly<
  z.infer<typeof LetterWardrobeThemeSchema>
>;

export const LetterWardrobeCatalogSchema = z
  .array(LetterWardrobeThemeSchema)
  .length(WARDROBE_THEME_IDS.length)
  .superRefine((catalog, context) => {
    const wrongOrder = WARDROBE_THEME_IDS.some(
      (themeId, index) => catalog[index]?.themeId !== themeId,
    );
    if (wrongOrder) {
      context.addIssue({
        code: "custom",
        message: "Letter wardrobe themes must retain canonical progression order.",
      });
    }
    if (new Set(catalog.map(({ pattern }) => pattern.id)).size !== catalog.length) {
      context.addIssue({
        code: "custom",
        message: "Every letter wardrobe theme must have a distinct pattern.",
      });
    }
    if (new Set(catalog.map(({ accent }) => accent.id)).size !== catalog.length) {
      context.addIssue({
        code: "custom",
        message: "Every letter wardrobe theme must have a distinct accent.",
      });
    }
  });

const RAW_LETTER_WARDROBE_CATALOG = [
  ["tech", "科技", "#0B1F33", "#F8FAFC", "#5EEAD4", "circuit-grid", "電路網格", "medium", "terminal-caret", "終端游標", "top-right"],
  ["finance", "理財", "#102A1F", "#F8FAFC", "#86EFAC", "ledger-grid", "帳本格線", "light", "steady-coin", "穩健錢幣", "bottom-right"],
  ["politics", "公民", "#24133D", "#F8FAFC", "#D8B4FE", "civic-ribbons", "公民緞帶", "medium", "dialogue-star", "對話星芒", "top-left"],
  ["education", "學習", "#172554", "#F8FAFC", "#93C5FD", "notebook-lines", "筆記橫線", "light", "open-book", "展開書頁", "bottom-right"],
  ["health", "健康", "#3F1725", "#F8FAFC", "#FDA4AF", "pulse-steps", "律動階梯", "medium", "care-cross", "照護十字", "top-right"],
  ["environment", "環境", "#12372A", "#F8FAFC", "#A7F3D0", "leaf-canopy", "葉冠紋理", "bold", "new-leaf", "新生葉片", "top-left"],
  ["law", "法律", "#242424", "#F8FAFC", "#FDE68A", "balanced-scales", "平衡刻線", "medium", "law-seal", "法律印記", "bottom-right"],
  ["relationship", "關係", "#3B1535", "#F8FAFC", "#F9A8D4", "interlocking-rings", "相扣圓環", "medium", "listening-knot", "傾聽繩結", "top-right"],
  ["family", "家庭", "#3A220F", "#F8FAFC", "#FCD34D", "woven-home", "家屋織紋", "bold", "home-heart", "安心家徽", "bottom-left"],
  ["workplace", "職場", "#1E293B", "#F8FAFC", "#CBD5E1", "checklist-grid", "清單方格", "light", "task-check", "完成勾記", "top-right"],
  ["science", "科學", "#082F49", "#F8FAFC", "#67E8F9", "constellation", "星圖節點", "medium", "research-spark", "研究火花", "top-left"],
  ["culture", "文化", "#3B1D0B", "#F8FAFC", "#FDBA74", "story-weave", "故事織紋", "bold", "story-mark", "故事印記", "bottom-right"],
  ["sports", "運動", "#3F1D14", "#F8FAFC", "#FDBA74", "speed-stripes", "速度斜紋", "bold", "victory-chevron", "勝利箭紋", "top-right"],
  ["food", "美食", "#3B2605", "#F8FAFC", "#FDE047", "table-check", "餐桌方格", "medium", "shared-plate", "共享餐盤", "bottom-left"],
  ["travel", "旅行", "#172554", "#F8FAFC", "#A5B4FC", "route-dashes", "旅程虛線", "light", "compass-point", "羅盤指針", "top-right"],
  ["psychology", "心理", "#2E1065", "#F8FAFC", "#C4B5FD", "soft-waves", "柔和波紋", "light", "reflection-orbit", "省思軌道", "bottom-right"],
  ["philosophy", "哲思", "#1C1917", "#F8FAFC", "#D6D3D1", "nested-circles", "層疊圓環", "medium", "question-ring", "提問圓環", "top-left"],
  ["international", "國際", "#0F2E2E", "#F8FAFC", "#99F6E4", "linked-arcs", "連結弧線", "medium", "world-link", "世界連結", "bottom-right"],
  ["media", "媒體", "#3B1426", "#F8FAFC", "#F9A8D4", "broadcast-rings", "播送環紋", "bold", "signal-dot", "訊號亮點", "top-right"],
  ["festival", "慶典", "#3B1B0B", "#F8FAFC", "#FDE68A", "confetti", "彩紙灑點", "bold", "celebration-star", "慶典星芒", "top-left"],
] as const satisfies readonly (readonly [
  WardrobeThemeId,
  string,
  string,
  string,
  string,
  LetterWardrobePatternId,
  string,
  "light" | "medium" | "bold",
  LetterWardrobeAccentId,
  string,
  "top-left" | "top-right" | "bottom-left" | "bottom-right",
])[];

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const LETTER_WARDROBE_CATALOG: readonly LetterWardrobeTheme[] = deepFreeze(
  LetterWardrobeCatalogSchema.parse(
    RAW_LETTER_WARDROBE_CATALOG.map(
      ([
        themeId,
        displayName,
        background,
        foreground,
        accentColor,
        patternId,
        patternLabel,
        density,
        accentId,
        accentLabel,
        placement,
      ]) => ({
        themeId,
        displayName,
        accessibleLabel: `${displayName}主題字母造型`,
        palette: { background, foreground, accent: accentColor },
        pattern: { id: patternId, label: patternLabel, density },
        accent: { id: accentId, label: accentLabel, placement },
      }),
    ),
  ),
);

const LETTER_WARDROBE_BY_THEME = new Map(
  LETTER_WARDROBE_CATALOG.map((theme) => [theme.themeId, theme] as const),
);

export function getLetterWardrobeTheme(
  themeId: WardrobeThemeId,
): LetterWardrobeTheme {
  const theme = LETTER_WARDROBE_BY_THEME.get(themeId);
  if (theme === undefined) {
    throw new Error(`Unknown wardrobe theme ID: ${themeId}`);
  }
  return theme;
}
