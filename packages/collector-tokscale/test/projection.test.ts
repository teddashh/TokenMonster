import { readFileSync } from "node:fs";

import {
  IngestSnapshotV1Schema,
  deserializeIngestSnapshotV1,
  serializeIngestSnapshotV1
} from "@tokenmonster/contracts";
import { describe, expect, it } from "vitest";

import {
  COLLECTOR_TOKSCALE_VERSION,
  CollectorTokscaleError,
  TOKSCALE_SOURCE_VERSION,
  projectTokscaleJsonToIngestSnapshotV1
} from "../src/index.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const BATCH_ID = "550e8400-e29b-41d4-a716-446655440000";

function fixture(name: string): string {
  return readFileSync(new URL("fixtures/" + name + ".json", import.meta.url), "utf8");
}

function metadata(client: string) {
  return {
    client,
    utcDate: "2026-07-15",
    batchId: BATCH_ID,
    generatedAt: "2026-07-15T12:34:56.000Z",
    revision: 3
  };
}

describe("Tokscale strict projection", () => {
  it("keeps emitted adapter and source versions synchronized with package pins", () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      version?: unknown;
      dependencies?: Record<string, unknown>;
    };

    expect(COLLECTOR_TOKSCALE_VERSION).toBe(packageManifest.version);
    expect(TOKSCALE_SOURCE_VERSION).toBe(
      packageManifest.dependencies?.["tokscale"]
    );
  });

  it.each([
    ["claude", "claude", "anthropic", "claude-sonnet", "claude-code"],
    ["codex", "codex", "openai", "openai-codex", "codex-cli"],
    ["gemini", "gemini", "google", "gemini-flash", "gemini-cli"],
    ["grok", "grok", "xai", "grok", "grok-build"]
  ])(
    "projects Tier-1 %s into coarse public dimensions",
    (_label, client, provider, modelFamily, tool) => {
      const snapshot = projectTokscaleJsonToIngestSnapshotV1(
        fixture(client),
        metadata(client),
        NOW
      );

      expect(snapshot.collector).toEqual({
        kind: "tokscale",
        adapterVersion: "0.1.0",
        sourceVersion: "4.5.2"
      });
      expect(snapshot.buckets[0]).toMatchObject({
        bucketStart: "2026-07-15T00:00:00.000Z",
        provider,
        modelFamily,
        tool,
        revision: 3
      });
      expect(IngestSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    }
  );

  it("keeps Codex reasoning as an output subset and includes cache in total", () => {
    const snapshot = projectTokscaleJsonToIngestSnapshotV1(
      fixture("codex"),
      metadata("codex"),
      NOW
    );
    expect(snapshot.buckets).toHaveLength(1);
    expect(snapshot.buckets[0]?.tokens).toEqual({
      input: "210",
      output: "100",
      cacheRead: "55",
      cacheWrite: "20",
      reasoning: "35",
      other: "0",
      total: "385"
    });
  });

  it("fails closed when a non-Codex client reports reasoning", () => {
    const raw = JSON.parse(fixture("gemini")) as {
      entries: Array<Record<string, unknown>>;
    };
    raw.entries[0]!["reasoning"] = 1;

    expect(() =>
      projectTokscaleJsonToIngestSnapshotV1(
        JSON.stringify(raw),
        metadata("gemini"),
        NOW
      )
    ).toThrowError(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "unsupported-reasoning"
      })
    );
  });

  it("allows upstream extras but strips all sensitive and diagnostic data", () => {
    const snapshot = projectTokscaleJsonToIngestSnapshotV1(
      fixture("sensitive-extras"),
      metadata("claude"),
      NOW
    );
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.buckets[0]?.modelFamily).toBe("anthropic-other");
    for (const secret of [
      "/Users/alice",
      "secret-project",
      "private prompt body",
      "private-session-id",
      "private diagnostic",
      "private-company-server",
      "messageCount",
      "performance",
      "warnings",
      "diagnostics",
      "cost",
      "mcpServers"
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("never passes an unknown raw provider or model through the public contract", () => {
    const raw = JSON.parse(fixture("claude")) as {
      entries: Array<Record<string, unknown>>;
    };
    raw.entries[0]!["provider"] = "private-provider/account-123";
    raw.entries[0]!["model"] = "/private/project/model-secret";

    const snapshot = projectTokscaleJsonToIngestSnapshotV1(
      JSON.stringify(raw),
      metadata("claude"),
      NOW
    );
    expect(snapshot.buckets[0]?.provider).toBe("other");
    expect(snapshot.buckets[0]?.modelFamily).toBe("other");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("rejects an aggregate collision that exceeds Number.MAX_SAFE_INTEGER", () => {
    const raw = {
      groupBy: "client,provider,model",
      entries: [
        {
          client: "claude",
          provider: "anthropic",
          model: "claude-sonnet-a",
          input: Number.MAX_SAFE_INTEGER,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0
        },
        {
          client: "claude",
          provider: "anthropic",
          model: "claude-sonnet-b",
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0
        }
      ]
    };

    expect(() =>
      projectTokscaleJsonToIngestSnapshotV1(
        JSON.stringify(raw),
        metadata("claude"),
        NOW
      )
    ).toThrowError(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "token-overflow"
      })
    );
  });

  it("round-trips the projected snapshot through the public contract", () => {
    const snapshot = projectTokscaleJsonToIngestSnapshotV1(
      fixture("claude"),
      metadata("claude"),
      NOW
    );
    const serialized = serializeIngestSnapshotV1(snapshot);
    expect(deserializeIngestSnapshotV1(serialized)).toEqual(snapshot);
  });

  it("reports an empty result instead of silently preserving old usage", () => {
    expect(() =>
      projectTokscaleJsonToIngestSnapshotV1(
        JSON.stringify({
          groupBy: "client,provider,model",
          entries: []
        }),
        metadata("claude"),
        NOW
      )
    ).toThrowError(
      expect.objectContaining<Partial<CollectorTokscaleError>>({
        code: "no-usage"
      })
    );
  });

  it("projects the previous UTC day while generatedAt stays current", () => {
    const snapshot = projectTokscaleJsonToIngestSnapshotV1(
      fixture("claude"),
      {
        ...metadata("claude"),
        utcDate: "2026-07-14",
        generatedAt: "2026-07-15T00:03:00.000Z"
      },
      NOW
    );
    expect(snapshot.generatedAt).toBe("2026-07-15T00:03:00.000Z");
    expect(snapshot.buckets[0]?.bucketStart).toBe(
      "2026-07-14T00:00:00.000Z"
    );
  });

  it.each([
    [{ ...metadata("claude"), client: "cursor" }],
    [{ ...metadata("claude"), utcDate: "2026-07-13" }],
    [{ ...metadata("claude"), generatedAt: "2026-07-14T12:00:00.000Z" }],
    [{ ...metadata("claude"), batchId: "not-a-uuid" }],
    [{ ...metadata("claude"), revision: 1.5 }]
  ])("rejects unsafe projection metadata", (invalidMetadata) => {
    expect(() =>
      projectTokscaleJsonToIngestSnapshotV1(
        fixture("claude"),
        invalidMetadata,
        NOW
      )
    ).toThrow(CollectorTokscaleError);
  });
});
