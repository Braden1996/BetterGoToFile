import { describe, expect, test } from "bun:test";
import {
  CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION,
  shouldRestoreCachedContributorState,
} from "../src/workspace/contributor-relationship-cache";

describe("contributor relationship cache helpers", () => {
  test("restores cached state when contributor, head commit, and index stamp still match", () => {
    expect(
      shouldRestoreCachedContributorState(
        {
          configuredContributor: {
            name: "Braden",
            email: "braden@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1024:55",
          version: CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION,
        },
        {
          configuredContributor: {
            name: "Braden",
            email: "braden@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1024:55",
        },
      ),
    ).toBe(true);
  });

  test("invalidates cached state when the index stamp changes", () => {
    expect(
      shouldRestoreCachedContributorState(
        {
          configuredContributor: {
            name: "Braden",
            email: "braden@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1024:55",
          version: CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION,
        },
        {
          configuredContributor: {
            name: "Braden",
            email: "braden@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1025:55",
        },
      ),
    ).toBe(false);
  });

  test("invalidates cached state when the configured contributor changes", () => {
    expect(
      shouldRestoreCachedContributorState(
        {
          configuredContributor: {
            name: "Braden",
            email: "braden@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1024:55",
          version: CONTRIBUTOR_RELATIONSHIP_CACHE_VERSION,
        },
        {
          configuredContributor: {
            name: "Alex",
            email: "alex@example.com",
          },
          headCommit: "abc123",
          indexStamp: "1024:55",
        },
      ),
    ).toBe(false);
  });
});
