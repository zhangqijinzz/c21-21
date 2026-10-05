import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  addRequestNode,
  removeRequestNode,
} from "../src/features/graph-editor/graphViewModel";
import {
  compareScenarios,
  describeNodeDeletionImpact,
  describeRestoreImpact,
  getSnapshotDrift,
  restoreScenario,
  saveScenario,
  summarizeRestore,
} from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";

describe("project and scenario view models", () => {
  it("creates a project and switches the active project", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const created = createProject(initial, 100);
    expect(created.projects).toHaveLength(2);
    expect(created.activeProjectId).not.toBe(EXAMPLE_PROJECT.id);
    expect(selectProject(created, EXAMPLE_PROJECT.id).activeProjectId).toBe(
      EXAMPLE_PROJECT.id,
    );
  });

  it("duplicates a project and remaps its dependency identities", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    expect(copy?.nodes[2]?.dependencyIds).toEqual([copy?.nodes[0]?.id]);
    expect(copy?.nodes[4]?.fallbackNodeId).toBe(copy?.nodes[3]?.id);
    expect(copy?.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(copy?.scenarios).toEqual([]);
  });

  it("saves a complete snapshot and restores its parameters", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const result = simulateProject(baseline);
    const saved = saveScenario(baseline, result, "并发方案");
    expect(saved.scenarios).toHaveLength(1);
    const changed = {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, durationMs: 999 })),
    };
    const restored = restoreScenario(changed, saved.scenarios[0]?.id ?? "");
    expect(restored.nodes[0]?.durationMs).toBe(baseline.nodes[0]?.durationMs);
  });

  it("describes node and concurrency differences between snapshots", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "不限并发",
    ).scenarios[0];
    const changed = {
      ...baseline,
      concurrencyLimit: 1,
      nodes: baseline.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 900 } : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "串行优化",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    expect(comparison.deltaMs).toBeGreaterThan(0);
    expect(comparison.changes.join(" ")).toContain("并发上限");
    expect(comparison.changes.join(" ")).toContain("耗时");
  });
});

describe("node deletion impact and snapshot drift", () => {
  it("reports dependents and scenarios that still contain the node", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线",
    );
    const impact = describeNodeDeletionImpact(saved, "session");
    expect(impact.scenarioNames).toEqual(["基线"]);
    expect(impact.dependentNames).toContain("用户资料");
    expect(impact.dependentNames).toContain("商品目录");
    const fallbackImpact = describeNodeDeletionImpact(saved, "catalog");
    expect(fallbackImpact.dependentNames).toContain("个性推荐");
  });

  it("marks snapshot drift after nodes are deleted or added", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线",
    );
    const scenario = saved.scenarios[0];
    if (!scenario) throw new Error("Scenario fixture should be saved");
    const trimmed = removeRequestNode(saved, "recommend");
    const drift = getSnapshotDrift(trimmed, scenario);
    expect(drift.inSync).toBe(false);
    expect(drift.missingInGraph.map((node) => node.name)).toEqual(["个性推荐"]);
    expect(drift.notInSnapshot).toHaveLength(0);
    const extended = addRequestNode(saved);
    const nextDrift = getSnapshotDrift(extended, scenario);
    expect(nextDrift.inSync).toBe(false);
    expect(nextDrift.notInSnapshot).toHaveLength(1);
    expect(nextDrift.missingInGraph).toHaveLength(0);
    expect(getSnapshotDrift(saved, scenario).inSync).toBe(true);
  });

  it("describes what a restore brings back and summarizes the outcome", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线",
    );
    const scenarioId = saved.scenarios[0]?.id ?? "";
    const trimmed = removeRequestNode(saved, "recommend");
    const tuned = {
      ...trimmed,
      concurrencyLimit: 1,
      nodes: trimmed.nodes.map((node) =>
        node.id === "session" ? { ...node, durationMs: 999 } : node,
      ),
    };
    const impact = describeRestoreImpact(tuned, scenarioId);
    if (!impact) throw new Error("Restore impact should be described");
    expect(impact.missingInGraph.map((node) => node.id)).toEqual(["recommend"]);
    expect(impact.notInSnapshot).toHaveLength(0);
    expect(impact.changed.join(" ")).toContain("耗时 999 → 280");
    expect(impact.concurrencyChange).toContain("并发上限");
    const summary = summarizeRestore(impact);
    expect(summary).toContain("带回 1 个已删除节点");
    expect(summary).toContain("个性推荐");
    expect(summary).toContain("并发上限");
  });

  it("keeps node-set wording consistent for snapshots saved around a deletion", () => {
    const before = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "删除前",
    ).scenarios[0];
    const trimmedProject = removeRequestNode(EXAMPLE_PROJECT, "recommend");
    const after = saveScenario(
      trimmedProject,
      simulateProject(trimmedProject),
      "删除后",
    ).scenarios[0];
    if (!before || !after) throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(before, after);
    expect(comparison.changes).toContain("个性推荐 · 已从对照方案移除");
    const reverse = compareScenarios(after, before);
    expect(reverse.changes).toContain("个性推荐 · 新增请求节点");
  });
});
