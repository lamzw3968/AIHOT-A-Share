// Discussion attention and cited catalysts. These fields never imply measured market performance.
export type TopicEvidenceStatus = "first_party" | "reported" | "unverified" | "clarified" | "mixed";
export type TopicTrend = "up" | "down" | "flat" | "new" | "unknown";

export interface TopicCatalyst {
  itemId: string;
  title: string;
  summary: string | null;
  publishedAt: string;
  sourceName: string;
  firstParty: boolean;
  url: string;
  storyPublicId: string | null;
  clarification: boolean;
}

export interface TopicHotEntry {
  rank: number;
  topic: { slug: string; name: string; definition: string; candidate: boolean };
  heat: number;
  trend: TopicTrend;
  trendPct: number | null;
  sourceGroupCount: number;
  discussionGroupCount: number;
  discussionCount: number;
  recentDiscussionCount: number;
  newSourceGroupCount: number;
  platformCount: number;
  platformNames: string[];
  sourceNames: string[];
  storyCount: number;
  reportCount: number;
  evidenceStatus: TopicEvidenceStatus;
  latestCatalyst: TopicCatalyst | null;
  catalysts: TopicCatalyst[];
  firstSeenAt: string;
  latestAt: string;
}

export interface TopicHotCoverage {
  countBasis: "source-groups";
  sourceCount: number;
  discussionSourceCount: number;
  platformCount: number;
  behindSourceCount: number;
  behindSourceNames: string[];
  inputCount: number;
  truncated: boolean;
  interactionMetricsAvailable: false;
}

export interface TopicHotResponse {
  computedAt: string | null;
  ruleVersion: string;
  windowHours: number;
  compareHours: number;
  halfLifeHours: number;
  topCount: number;
  refreshAt: string | null;
  stale: boolean;
  entries: TopicHotEntry[];
  coverage: TopicHotCoverage;
  marketDataAvailable: false;
}

export interface TopicHotDetail {
  board: Omit<TopicHotResponse, "entries">;
  topic: TopicHotEntry;
  discussionLinks: Array<{ sourceName: string; url: string; observedAt: string }>;
}
