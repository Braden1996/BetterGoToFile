import { describe, expect, test } from "bun:test";
import {
  collectPackageRootDirectories,
  findNearestPackageRoot,
} from "../src/workspace/package-root";

describe("package root detection", () => {
  test("collects package roots from package.json and project.json manifests", () => {
    const packageRoots = collectPackageRootDirectories([
      "package.json",
      "packages/design-system/package.json",
      "apps/web/project.json",
      "packages/design-system/src/tasks/button.tsx",
    ]);

    expect([...packageRoots].sort()).toEqual(["", "apps/web", "packages/design-system"]);
  });

  test("returns the nearest package root for a file directory", () => {
    const packageRoots = new Set([
      "packages/design-system",
      "packages/design-system/examples/storybook",
    ]);

    expect(findNearestPackageRoot("packages/design-system/src/tasks", packageRoots)).toBe(
      "packages/design-system",
    );
    expect(
      findNearestPackageRoot("packages/design-system/examples/storybook/src", packageRoots),
    ).toBe("packages/design-system/examples/storybook");
    expect(findNearestPackageRoot("tools/scripts", packageRoots)).toBeUndefined();
  });
});
