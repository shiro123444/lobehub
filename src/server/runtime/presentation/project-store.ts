import type {
  PresentationProject,
  PresentationProjectInput,
  PresentationProjectStore,
  PresentationVersion,
  PresentationVersionInput,
  PresentationVersionKind,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';

export type PresentationProjectStoreErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_SCOPE_MISMATCH'
  | 'PROJECT_INVALID_VERSION';

export class PresentationProjectStoreError extends Error {
  constructor(
    public readonly code: PresentationProjectStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PresentationProjectStoreError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const cloneWireValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneWireValue(item)) as T;
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value)) clone[key] = cloneWireValue(nested);
      return clone as T;
    }
  }
  return value;
};

const scopeKey = (scope: RuntimeScope): string => {
  if (!isRecord(scope) || !nonEmpty(scope.userId) || !nonEmpty(scope.sessionId)) {
    throw new PresentationProjectStoreError(
      'PROJECT_SCOPE_MISMATCH',
      'A non-empty userId and sessionId are required',
    );
  }
  return `${scope.userId}\u0000${scope.sessionId}`;
};

const cloneVersion = (version: PresentationVersion): PresentationVersion => ({
  ...version,
  artifactIds: [...version.artifactIds],
  metadata: version.metadata ? cloneWireValue(version.metadata) : undefined,
});

const cloneProject = (project: PresentationProject): PresentationProject => ({
  ...project,
  sourceVersion: cloneVersion(project.sourceVersion),
  designSpecVersion: cloneVersion(project.designSpecVersion),
  slideVersions: project.slideVersions.map(cloneVersion),
  artifactVersions: project.artifactVersions.map(cloneVersion),
  metadata: project.metadata ? cloneWireValue(project.metadata) : undefined,
});

const invalidVersion = (message: string): PresentationProjectStoreError =>
  new PresentationProjectStoreError('PROJECT_INVALID_VERSION', message);

const allVersions = (project: PresentationProject): PresentationVersion[] => [
  project.sourceVersion,
  project.designSpecVersion,
  ...project.slideVersions,
  ...project.artifactVersions,
];

const normalizeVersion = (
  version: PresentationVersionInput,
  id: string,
  defaultKind: PresentationVersionKind,
  now: string,
): PresentationVersion => {
  if (!isRecord(version)) throw invalidVersion('version must be an object');
  const candidate = version as PresentationVersionInput;
  const versionId = candidate.id ?? id;
  if (!nonEmpty(versionId)) throw invalidVersion('version id must be non-empty');
  const kind = candidate.kind ?? defaultKind;
  if (!['source', 'design-spec', 'slide', 'artifact', 'composite'].includes(kind)) {
    throw invalidVersion(`unsupported version kind: ${String(kind)}`);
  }
  if (candidate.parentVersionId !== undefined && !nonEmpty(candidate.parentVersionId)) {
    throw invalidVersion('parentVersionId must be non-empty when provided');
  }
  const artifactIds = candidate.artifactIds ?? [];
  if (!Array.isArray(artifactIds) || artifactIds.some((artifactId) => !nonEmpty(artifactId))) {
    throw invalidVersion('artifactIds must be a string array');
  }
  return {
    id: versionId,
    kind,
    parentVersionId: candidate.parentVersionId,
    artifactIds: [...new Set(artifactIds)],
    metadata: candidate.metadata ? cloneWireValue(candidate.metadata) : undefined,
    createdAt: now,
  };
};

/** In-memory C-48 store; each instance is an isolated test/development seam. */
export class InMemoryPresentationProjectStore implements PresentationProjectStore {
  private readonly projects = new Map<string, PresentationProject>();
  private readonly projectScopes = new Map<string, string>();
  private projectSequence = 0;
  private versionSequence = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async create(scope: RuntimeScope, input: PresentationProjectInput): Promise<PresentationProject> {
    const key = scopeKey(scope);
    if (!isRecord(input) || !isRecord(input.sourceVersion)) {
      throw invalidVersion('sourceVersion is required');
    }
    const projectId = `project-${++this.projectSequence}`;
    const timestamp = this.now();
    const source = normalizeVersion(
      input.sourceVersion,
      `version-${++this.versionSequence}`,
      'source',
      timestamp,
    );
    if (source.kind !== 'source') {
      throw invalidVersion('sourceVersion must have kind source');
    }
    const design = normalizeVersion(
      input.designSpecVersion ?? { parentVersionId: source.id, kind: 'design-spec' },
      `version-${++this.versionSequence}`,
      'design-spec',
      timestamp,
    );
    if (design.kind !== 'design-spec') {
      throw invalidVersion('designSpecVersion must have kind design-spec');
    }
    if (design.parentVersionId !== source.id) {
      throw invalidVersion('designSpecVersion must be parented to sourceVersion');
    }
    const project: PresentationProject = {
      id: projectId,
      title: input.title,
      sourceVersion: source,
      designSpecVersion: design,
      slideVersions: [],
      artifactVersions: [],
      currentVersion: input.currentVersion ?? design.id,
      metadata: input.metadata ? cloneWireValue(input.metadata) : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    for (const version of input.slideVersions ?? []) this.appendInitial(project, version, 'slide');
    for (const version of input.artifactVersions ?? []) {
      this.appendInitial(project, version, 'artifact');
    }
    if (!allVersions(project).some(({ id }) => id === project.currentVersion)) {
      throw invalidVersion(`currentVersion is not present: ${project.currentVersion}`);
    }
    const storageKey = `${key}\u0000${project.id}`;
    this.projects.set(storageKey, project);
    this.projectScopes.set(project.id, key);
    return cloneProject(project);
  }

  async get(scope: RuntimeScope, projectId: string): Promise<PresentationProject | null> {
    const project = this.resolve(scopeKey(scope), projectId);
    return project ? cloneProject(project) : null;
  }

  async appendVersion(
    scope: RuntimeScope,
    projectId: string,
    version: PresentationVersionInput,
  ): Promise<PresentationProject> {
    const project = this.require(scopeKey(scope), projectId);
    const normalized = normalizeVersion(
      version,
      `version-${++this.versionSequence}`,
      version.kind ?? 'composite',
      this.now(),
    );
    if (normalized.kind === 'source' || normalized.kind === 'design-spec') {
      throw invalidVersion('source and design-spec versions are immutable project roots');
    }
    const existing = allVersions(project);
    if (existing.some(({ id }) => id === normalized.id)) {
      throw invalidVersion(`version already exists: ${normalized.id}`);
    }
    if (
      !normalized.parentVersionId ||
      !existing.some(({ id }) => id === normalized.parentVersionId)
    ) {
      throw invalidVersion(
        `parentVersionId is missing or unknown: ${normalized.parentVersionId ?? ''}`,
      );
    }
    if (
      normalized.artifactIds.some((artifactId) =>
        existing.some((stored) => stored.artifactIds.includes(artifactId)),
      )
    ) {
      throw invalidVersion('new version cannot overwrite an existing artifact');
    }
    if (normalized.kind === 'slide') project.slideVersions.push(normalized);
    else project.artifactVersions.push(normalized);
    project.updatedAt = this.now();
    return cloneProject(project);
  }

  async selectVersion(
    scope: RuntimeScope,
    projectId: string,
    versionId: string,
  ): Promise<PresentationProject> {
    const project = this.require(scopeKey(scope), projectId);
    if (!nonEmpty(versionId) || !allVersions(project).some(({ id }) => id === versionId)) {
      throw invalidVersion(`version is not present: ${versionId}`);
    }
    project.currentVersion = versionId;
    project.updatedAt = this.now();
    return cloneProject(project);
  }

  private appendInitial(
    project: PresentationProject,
    version: PresentationVersionInput,
    defaultKind: PresentationVersionKind,
  ): void {
    const normalized = normalizeVersion(
      version,
      `version-${++this.versionSequence}`,
      defaultKind,
      project.createdAt,
    );
    if (
      !normalized.parentVersionId ||
      !allVersions(project).some(({ id }) => id === normalized.parentVersionId)
    ) {
      throw invalidVersion(
        `initial version parent is unknown: ${normalized.parentVersionId ?? ''}`,
      );
    }
    if (allVersions(project).some(({ id }) => id === normalized.id)) {
      throw invalidVersion(`version already exists: ${normalized.id}`);
    }
    if (normalized.kind === 'slide') project.slideVersions.push(normalized);
    else project.artifactVersions.push(normalized);
  }

  private resolve(scope: string, projectId: string): PresentationProject | undefined {
    if (!nonEmpty(projectId)) {
      throw new PresentationProjectStoreError('PROJECT_NOT_FOUND', 'projectId is required');
    }
    const project = this.projects.get(`${scope}\u0000${projectId}`);
    if (!project && this.projectScopes.has(projectId)) {
      throw new PresentationProjectStoreError(
        'PROJECT_SCOPE_MISMATCH',
        `Project belongs to another scope: ${projectId}`,
      );
    }
    return project;
  }

  private require(scope: string, projectId: string): PresentationProject {
    const project = this.resolve(scope, projectId);
    if (!project) {
      throw new PresentationProjectStoreError(
        'PROJECT_NOT_FOUND',
        `Project is not found: ${projectId}`,
      );
    }
    return project;
  }
}
