import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
  getNodeDeletionImpact,
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

  it("reports which snapshots still hold a node before it is deleted", () => {
    const withSnapshot = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "完整链路",
    );
    const trimmed = {
      ...withSnapshot,
      nodes: withSnapshot.nodes.filter((node) => node.id !== "recommend"),
    };
    const afterTrim = saveScenario(
      trimmed,
      simulateProject(trimmed),
      "去掉推荐",
    );
    const impact = getNodeDeletionImpact(afterTrim, "recommend");
    expect(impact.dependentNames).toEqual([]);
    expect(impact.fallbackUserNames).toEqual([]);
    expect(impact.scenarioNames).toEqual(["完整链路"]);
    const refs = getNodeDeletionImpact(withSnapshot, "session");
    expect(refs.dependentNames).toEqual(
      expect.arrayContaining(["用户资料", "商品目录"]),
    );
    expect(refs.fallbackUserNames).toEqual([]);
    const fallbackRefs = getNodeDeletionImpact(withSnapshot, "catalog");
    expect(fallbackRefs.fallbackUserNames).toEqual(["个性推荐"]);
  });

  it("summarizes what a restore brings back and what it removes", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线",
    );
    const snapshot = saved.scenarios[0];
    if (!snapshot) throw new Error("Scenario fixture should be saved");
    const drifted = {
      ...saved,
      concurrencyLimit: 2,
      nodes: [
        ...saved.nodes
          .filter((node) => node.id !== "recommend")
          .map((node) =>
            node.id === "session" ? { ...node, durationMs: 999 } : node,
          ),
        {
          ...saved.nodes[0]!,
          id: "extra",
          name: "临时节点",
          dependencyIds: [],
          fallbackNodeId: undefined,
        },
      ],
    };
    const summary = summarizeRestore(drifted, snapshot);
    expect(summary.revivedNames).toEqual(["个性推荐"]);
    expect(summary.removedNames).toEqual(["临时节点"]);
    expect(summary.updatedNames).toEqual(["会话校验"]);
    expect(summary.concurrencyChanged).toBe(true);
    const restored = restoreScenario(drifted, snapshot.id);
    expect(summarizeRestore(restored, snapshot)).toEqual({
      revivedNames: [],
      removedNames: [],
      updatedNames: [],
      concurrencyChanged: false,
    });
  });

  it("measures node-set drift between a snapshot and the current graph", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线",
    );
    const snapshot = saved.scenarios[0];
    if (!snapshot) throw new Error("Scenario fixture should be saved");
    const drifted = {
      ...saved,
      nodes: [
        ...saved.nodes.filter((node) => node.id !== "recommend"),
        {
          ...saved.nodes[0]!,
          id: "extra",
          name: "临时节点",
          dependencyIds: [],
          fallbackNodeId: undefined,
        },
      ],
    };
    expect(getSnapshotDrift(drifted, snapshot)).toEqual({
      deletedFromGraph: ["个性推荐"],
      addedToGraph: ["临时节点"],
    });
    expect(getSnapshotDrift(saved, snapshot)).toEqual({
      deletedFromGraph: [],
      addedToGraph: [],
    });
  });
});
