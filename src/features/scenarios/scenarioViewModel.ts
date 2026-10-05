import type {
  LatencyProject,
  RequestNode,
  ScenarioSnapshot,
  SimulationResult,
} from "../../shared/domain/types";

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
}

export interface NodeSetDiff {
  added: RequestNode[];
  removed: RequestNode[];
  changed: string[];
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

export function diffNodeSets(
  baseline: RequestNode[],
  comparison: RequestNode[],
): NodeSetDiff {
  const baselineNodes = new Map(baseline.map((node) => [node.id, node]));
  const comparisonNodes = new Map(comparison.map((node) => [node.id, node]));
  return {
    removed: baseline.filter((node) => !comparisonNodes.has(node.id)),
    added: comparison.filter((node) => !baselineNodes.has(node.id)),
    changed: baseline.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next ? describeNodeChanges(node, next) : [];
    }),
  };
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const diff = diffNodeSets(baseline.nodes, comparison.nodes);
  const changes = [
    ...diff.changed,
    ...diff.removed.map((node) => `${node.name} · 已从对照方案移除`),
    ...diff.added.map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}

export interface NodeDeletionImpact {
  dependentNames: string[];
  scenarioNames: string[];
}

export function describeNodeDeletionImpact(
  project: LatencyProject,
  nodeId: string,
): NodeDeletionImpact {
  return {
    dependentNames: project.nodes
      .filter(
        (node) =>
          node.id !== nodeId &&
          (node.dependencyIds.includes(nodeId) ||
            node.fallbackNodeId === nodeId),
      )
      .map((node) => node.name),
    scenarioNames: project.scenarios
      .filter((scenario) => scenario.nodes.some((node) => node.id === nodeId))
      .map((scenario) => scenario.name),
  };
}

export interface SnapshotDrift {
  missingInGraph: RequestNode[];
  notInSnapshot: RequestNode[];
  inSync: boolean;
}

export function getSnapshotDrift(
  project: LatencyProject,
  scenario: ScenarioSnapshot,
): SnapshotDrift {
  const graphIds = new Set(project.nodes.map((node) => node.id));
  const snapshotIds = new Set(scenario.nodes.map((node) => node.id));
  const missingInGraph = scenario.nodes.filter(
    (node) => !graphIds.has(node.id),
  );
  const notInSnapshot = project.nodes.filter(
    (node) => !snapshotIds.has(node.id),
  );
  return {
    missingInGraph,
    notInSnapshot,
    inSync: missingInGraph.length === 0 && notInSnapshot.length === 0,
  };
}

export interface RestoreImpact extends SnapshotDrift {
  scenario: ScenarioSnapshot;
  changed: string[];
  concurrencyChange: string | null;
}

export function describeRestoreImpact(
  project: LatencyProject,
  scenarioId: string,
): RestoreImpact | undefined {
  const scenario = project.scenarios.find((item) => item.id === scenarioId);
  if (!scenario) return undefined;
  const drift = getSnapshotDrift(project, scenario);
  const graphNodes = new Map(project.nodes.map((node) => [node.id, node]));
  const changed = scenario.nodes.flatMap((node) => {
    const current = graphNodes.get(node.id);
    return current ? describeNodeChanges(current, node) : [];
  });
  const concurrencyChange =
    project.concurrencyLimit === scenario.concurrencyLimit
      ? null
      : `并发上限 · ${project.concurrencyLimit ?? "不限"} → ${scenario.concurrencyLimit ?? "不限"}`;
  return { ...drift, scenario, changed, concurrencyChange };
}

export function summarizeRestore(impact: RestoreImpact): string {
  const parts: string[] = [];
  if (impact.missingInGraph.length)
    parts.push(
      `带回 ${impact.missingInGraph.length} 个已删除节点（${impact.missingInGraph
        .map((node) => node.name)
        .join("、")}）`,
    );
  if (impact.notInSnapshot.length)
    parts.push(
      `移除 ${impact.notInSnapshot.length} 个当前节点（${impact.notInSnapshot
        .map((node) => node.name)
        .join("、")}）`,
    );
  if (impact.changed.length)
    parts.push(`覆盖 ${impact.changed.length} 项参数差异`);
  if (impact.concurrencyChange) parts.push(impact.concurrencyChange);
  return parts.length
    ? `已恢复方案「${impact.scenario.name}」：${parts.join("；")}。`
    : `已恢复方案「${impact.scenario.name}」，当前图与方案一致。`;
}
