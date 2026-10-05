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

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
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

export interface NodeDeletionImpact {
  dependentNames: string[];
  fallbackUserNames: string[];
  scenarioNames: string[];
}

export function getNodeDeletionImpact(
  project: LatencyProject,
  nodeId: string,
): NodeDeletionImpact {
  return {
    dependentNames: project.nodes
      .filter((node) => node.dependencyIds.includes(nodeId))
      .map((node) => node.name),
    fallbackUserNames: project.nodes
      .filter((node) => node.fallbackNodeId === nodeId)
      .map((node) => node.name),
    scenarioNames: project.scenarios
      .filter((scenario) => scenario.nodes.some((node) => node.id === nodeId))
      .map((scenario) => scenario.name),
  };
}

export interface RestoreSummary {
  revivedNames: string[];
  removedNames: string[];
  updatedNames: string[];
  concurrencyChanged: boolean;
}

export function summarizeRestore(
  project: LatencyProject,
  snapshot: ScenarioSnapshot,
): RestoreSummary {
  const currentById = new Map(project.nodes.map((node) => [node.id, node]));
  const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
  const revivedNames: string[] = [];
  const updatedNames: string[] = [];
  for (const node of snapshot.nodes) {
    const current = currentById.get(node.id);
    if (!current) {
      revivedNames.push(node.name);
    } else if (
      current.name !== node.name ||
      describeNodeChanges(current, node).length > 0
    ) {
      updatedNames.push(node.name);
    }
  }
  return {
    revivedNames,
    removedNames: project.nodes
      .filter((node) => !snapshotIds.has(node.id))
      .map((node) => node.name),
    updatedNames,
    concurrencyChanged: project.concurrencyLimit !== snapshot.concurrencyLimit,
  };
}

export interface SnapshotDrift {
  deletedFromGraph: string[];
  addedToGraph: string[];
}

export function getSnapshotDrift(
  project: LatencyProject,
  snapshot: ScenarioSnapshot,
): SnapshotDrift {
  const currentIds = new Set(project.nodes.map((node) => node.id));
  const snapshotIds = new Set(snapshot.nodes.map((node) => node.id));
  return {
    deletedFromGraph: snapshot.nodes
      .filter((node) => !currentIds.has(node.id))
      .map((node) => node.name),
    addedToGraph: project.nodes
      .filter((node) => !snapshotIds.has(node.id))
      .map((node) => node.name),
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
