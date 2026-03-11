import { describe, expect, test } from "vitest";
import {
  buildCloudflareAppTag,
  buildCloudflareDeploymentTag,
  findCloudflareAppTag,
  findCloudflareDeploymentTag,
  getCloudflareAppIdFromTag,
  getCloudflareDeploymentIdFromTag,
} from "./deployment-tag";

describe("deployment-tag helpers", () => {
  test("builds separate app and deployment tags", () => {
    const prefix = "fragno";
    const appTag = buildCloudflareAppTag("tenant-app", prefix);
    const deploymentTag = buildCloudflareDeploymentTag("dep_123", prefix);

    expect(appTag).toBe("fragno-app-tenant-app");
    expect(deploymentTag).toBe("fragno-dep-dep-123");
    expect(getCloudflareAppIdFromTag(appTag, prefix)).toBe("tenant-app");
    expect(getCloudflareDeploymentIdFromTag(deploymentTag, prefix)).toBe("dep-123");
  });

  test("caps long prefixes so app and deployment tags stay within Cloudflare's limit", () => {
    const prefix = "fragno-iicsu05jvbh6tcsjwlkkqnr4-deployment";
    const appId = "tenant-app";
    const deploymentId = "jesp0ss21c543f3nkqgoj6iz";

    const appTag = buildCloudflareAppTag(appId, prefix);
    const deploymentTag = buildCloudflareDeploymentTag(deploymentId, prefix);

    expect(appTag.length).toBeLessThanOrEqual(63);
    expect(deploymentTag.length).toBeLessThanOrEqual(63);
    expect(appTag).toMatch(/-app-tenant-app$/);
    expect(deploymentTag).toMatch(/-dep-jesp0ss21c543f3nkqgoj6iz$/);
    expect(getCloudflareAppIdFromTag(appTag, prefix)).toBe(appId);
    expect(getCloudflareDeploymentIdFromTag(deploymentTag, prefix)).toBe(deploymentId);
    expect(findCloudflareAppTag([deploymentTag, appTag], prefix)).toBe(appTag);
    expect(findCloudflareDeploymentTag([appTag, deploymentTag], prefix)).toBe(deploymentTag);
  });

  test("round-trips tags when the configured prefix ends with the same marker segment", () => {
    const appPrefix = "fragno-app";
    const deploymentPrefix = "fragno-dep";
    const appTag = buildCloudflareAppTag("tenant-app", appPrefix);
    const deploymentTag = buildCloudflareDeploymentTag("dep-123", deploymentPrefix);

    expect(appTag).toBe("fragno-app-app-tenant-app");
    expect(deploymentTag).toBe("fragno-dep-dep-dep-123");
    expect(getCloudflareAppIdFromTag(appTag, appPrefix)).toBe("tenant-app");
    expect(getCloudflareDeploymentIdFromTag(deploymentTag, deploymentPrefix)).toBe("dep-123");
    expect(findCloudflareAppTag([deploymentTag, appTag], appPrefix)).toBe(appTag);
    expect(findCloudflareDeploymentTag([appTag, deploymentTag], deploymentPrefix)).toBe(
      deploymentTag,
    );
  });
});
