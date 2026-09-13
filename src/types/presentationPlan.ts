/** An agent-authored proposal, not a fixed workflow or an execution receipt. */
export interface PresentationCreativePlan {
  goal: string;
  narrative: string;
  rationale: string;
  steps: { action: string; reason: string }[];
  successCriteria: string[];
}
