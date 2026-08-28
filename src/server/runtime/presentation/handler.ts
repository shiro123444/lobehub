import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJobInput,
  PresentationPort,
} from '../../../../packages/cordis-kernel/src/presentation';
import type {
  PresentationFactoryScope,
  PresentationPortBinding,
  PresentationPortFactory,
} from './factory';
import { getPresentationPortFactory } from './factory';

export type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  PresentationPort,
} from '../../../../packages/cordis-kernel/src/presentation';
export type {
  PresentationFactoryScope,
  PresentationPortBinding,
  PresentationPortFactory,
} from './factory';

export type PresentationRouteOperation =
  | 'create'
  | 'get'
  | 'cancel'
  | 'retry'
  | 'getArtifact'
  | 'exportArtifact'
  | 'notFound';

export interface PresentationRouteMatch {
  readonly id?: string;
  readonly operation: PresentationRouteOperation;
}

export interface PresentationHttpResponse {
  readonly body: unknown;
  readonly headers: {
    readonly 'content-type': 'application/json';
  };
  readonly status: number;
}

class PresentationRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PresentationRequestError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const ownProperty = (value: unknown, key: string): unknown => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const stringProperty = (value: unknown, key: string): string | undefined => {
  const property = ownProperty(value, key);
  return typeof property === 'string' && property.trim() ? property : undefined;
};

const errorCode = (error: unknown): string =>
  stringProperty(error, 'code') ?? 'PRESENTATION_INTERNAL_ERROR';

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return stringProperty(error, 'message') ?? 'Presentation request failed';
};

const errorPath = (error: unknown): string | undefined => stringProperty(error, 'path');

const errorDetails = (error: unknown): Record<string, string> | undefined => {
  const details: Record<string, string> = {};
  const source = ownProperty(error, 'details');
  if (isPlainObject(source)) {
    for (const key of ['jobId', 'artifactId', 'path']) {
      const value = stringProperty(source, key);
      if (value) details[key] = value;
    }
  }
  for (const key of ['jobId', 'artifactId']) {
    const value = stringProperty(error, key);
    if (value) details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
};

const statusForCode = (code: string): number => {
  if (code === 'PRESENTATION_INVALID') return 400;
  if (code === 'PRESENTATION_NOT_FOUND' || code === 'PRESENTATION_ROUTE_NOT_FOUND') return 404;
  if (code === 'PRESENTATION_CANCEL_FAILED') return 502;
  if (code === 'PRESENTATION_TIMEOUT') return 504;
  if (code === 'PRESENTATION_OUTPUT_LIMIT') return 413;
  if (code === 'PROVIDER_UNAVAILABLE') return 503;
  if (code === 'PPTX_INVALID') return 502;
  return 500;
};

export const presentationHttpErrorResponse = (error: unknown): PresentationHttpResponse => {
  const code = errorCode(error);
  const path = errorPath(error);
  const details = errorDetails(error);
  return {
    status: statusForCode(code),
    headers: JSON_HEADERS,
    body: {
      error: {
        code,
        message: errorMessage(error),
        ...(path ? { path } : {}),
        ...(details ? { details } : {}),
      },
    },
  };
};

const successResponse = (body: unknown): PresentationHttpResponse => ({
  status: 200,
  headers: JSON_HEADERS,
  body,
});

const pathSegments = (request: Request): string[] => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  const relativeSegments =
    presentationIndex >= 0 ? segments.slice(presentationIndex + 1) : segments;
  try {
    return relativeSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Path contains an invalid encoded segment',
      'path',
    );
  }
};

export const matchPresentationRoute = (request: Request): PresentationRouteMatch => {
  const segments = pathSegments(request);
  const method = request.method.toUpperCase();
  if (segments.length === 1 && segments[0] === 'jobs' && method === 'POST') {
    return { operation: 'create' };
  }
  if (segments.length === 2 && segments[0] === 'jobs' && method === 'GET') {
    return { operation: 'get', id: segments[1] };
  }
  if (segments.length === 3 && segments[0] === 'jobs' && method === 'POST') {
    if (segments[2] === 'cancel') return { operation: 'cancel', id: segments[1] };
    if (segments[2] === 'retry') return { operation: 'retry', id: segments[1] };
  }
  if (segments.length === 2 && segments[0] === 'artifacts' && method === 'GET') {
    return { operation: 'getArtifact', id: segments[1] };
  }
  if (
    segments.length === 2 &&
    segments[0] === 'artifacts' &&
    segments[1] === 'export' &&
    method === 'POST'
  )
    return { operation: 'exportArtifact' };
  if (
    segments.length === 3 &&
    segments[0] === 'artifacts' &&
    segments[2] === 'export' &&
    method === 'POST'
  )
    return { operation: 'exportArtifact', id: segments[1] };
  return { operation: 'notFound' };
};

const readJsonObject = async (request: Request): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new PresentationRequestError('PRESENTATION_INVALID', 'Unable to read request body', '$');
  }
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Request body must be valid JSON',
      '$',
    );
  }
  if (!isPlainObject(value)) {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Request body must be an object',
      '$',
    );
  }
  return value;
};

const requiredId = (id: string | undefined, path: string): string => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new PresentationRequestError('PRESENTATION_INVALID', `${path} must be non-empty`, path);
  }
  return id;
};

const isPresentationPort = (value: unknown): value is PresentationPort =>
  isRecord(value) &&
  typeof value.createJob === 'function' &&
  typeof value.getJob === 'function' &&
  typeof value.cancelJob === 'function' &&
  typeof value.retryJob === 'function' &&
  typeof value.getArtifact === 'function' &&
  typeof value.exportArtifact === 'function';

const isBinding = (value: unknown): value is PresentationPortBinding =>
  isRecord(value) && isPresentationPort(value.port);

const resolvePort = (value: unknown): PresentationPort => {
  if (isPresentationPort(value)) return value;
  if (isBinding(value)) return value.port;
  throw new PresentationRequestError(
    'PROVIDER_UNAVAILABLE',
    'Presentation factory did not provide a PresentationPort',
  );
};

const isPresentationFormat = (value: unknown): value is PresentationExportFormat =>
  value === 'pptx' || value === 'svg' || value === 'pdf' || value === 'quality-report';

const notFound = (kind: string, id: string): PresentationRequestError =>
  new PresentationRequestError(
    'PRESENTATION_NOT_FOUND',
    `${kind} does not exist: ${id}`,
    `${kind}Id`,
    {
      [`${kind}Id`]: id,
    },
  );

export const handlePresentationRequest = async (
  request: Request,
  scope: Omit<PresentationFactoryScope, 'request'>,
  match: PresentationRouteMatch,
  factory: PresentationPortFactory = getPresentationPortFactory(),
): Promise<PresentationHttpResponse> => {
  try {
    if (match.operation === 'notFound') {
      throw new PresentationRequestError(
        'PRESENTATION_ROUTE_NOT_FOUND',
        'Presentation route was not found',
      );
    }

    const result = await factory({ ...scope, request });
    const port = resolvePort(result);
    if (match.operation === 'create') {
      const input = (await readJsonObject(request)) as unknown as PresentationJobInput;
      return successResponse(await port.createJob(input));
    }

    if (match.operation === 'exportArtifact') {
      const body = await readJsonObject(request);
      const artifactId =
        match.id ?? (typeof body.artifactId === 'string' ? body.artifactId : undefined);
      const id = requiredId(artifactId, 'artifactId');
      const queryFormat = new URL(request.url).searchParams.get('format') ?? undefined;
      const format = body.format ?? queryFormat;
      if (!isPresentationFormat(format)) {
        throw new PresentationRequestError(
          'PRESENTATION_INVALID',
          'format must be one of pptx, svg, pdf, quality-report',
          'format',
        );
      }
      return successResponse((await port.exportArtifact(id, format)) as ExportResult);
    }

    const id = requiredId(match.id, match.operation === 'getArtifact' ? 'artifactId' : 'jobId');
    if (match.operation === 'get') {
      const job = await port.getJob(id);
      if (!job) throw notFound('job', id);
      return successResponse(job);
    }
    if (match.operation === 'cancel') return successResponse(await port.cancelJob(id));
    if (match.operation === 'retry') return successResponse(await port.retryJob(id));
    if (match.operation === 'getArtifact') {
      const artifact = await port.getArtifact(id);
      if (!artifact) throw notFound('artifact', id);
      return successResponse(artifact as ArtifactSnapshot);
    }
    throw new PresentationRequestError(
      'PRESENTATION_ROUTE_NOT_FOUND',
      'Presentation route was not found',
    );
  } catch (error) {
    return presentationHttpErrorResponse(error);
  }
};
