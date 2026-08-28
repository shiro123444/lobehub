import { RUNTIME_PROTOCOL_VERSION } from './run';

export interface CommandEnvelope {
  [key: string]: unknown;
  command: string;
  payload: Record<string, unknown>;
  protocol_version: typeof RUNTIME_PROTOCOL_VERSION;
  request_id: string;
}

export type ProtocolErrorCode = 'PROTOCOL_INVALID';

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ProtocolError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalid = (path: string, message: string): never => {
  throw new ProtocolError('PROTOCOL_INVALID', path, message);
};

const childPath = (path: string, key: string | number): string => {
  const suffix =
    typeof key === 'number' || /^[A-Z_$][\w$]*$/i.test(key)
      ? String(key)
      : `[${JSON.stringify(key)}]`;
  return path === '$' ? suffix : `${path}.${suffix}`;
};

const cloneJson = (value: unknown, path: string, active: WeakSet<object>): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    invalid(path, 'must contain only finite JSON numbers');
  }
  const objectValue =
    typeof value === 'object' && value !== null
      ? value
      : invalid(path, 'must contain only JSON-compatible values');
  if (active.has(objectValue)) invalid(path, 'must not contain cyclic references');

  active.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const clone: unknown[] = [];
      for (let index = 0; index < objectValue.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, String(index));
        const dataDescriptor =
          descriptor && 'value' in descriptor
            ? descriptor
            : invalid(childPath(path, index), 'must be a data property');
        clone.push(cloneJson(dataDescriptor.value, childPath(path, index), active));
      }
      return clone;
    }

    const plainObject = isPlainObject(objectValue)
      ? objectValue
      : invalid(path, 'must be a plain object');
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(plainObject)) {
      const descriptor = Object.getOwnPropertyDescriptor(plainObject, key);
      const dataDescriptor =
        descriptor && 'value' in descriptor
          ? descriptor
          : invalid(childPath(path, key), 'must be a data property');
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJson(dataDescriptor.value, childPath(path, key), active),
        writable: true,
      });
    }
    return clone;
  } finally {
    active.delete(objectValue);
  }
};

export class CommandEnvelopeCodec {
  encode(input: unknown): string {
    return JSON.stringify(this.validate(input));
  }

  decode(encoded: string): CommandEnvelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      invalid('$', 'must be valid JSON');
    }
    return this.validate(parsed);
  }

  validate(input: unknown): CommandEnvelope {
    const cloned = cloneJson(input, '$', new WeakSet<object>());
    const candidate = isPlainObject(cloned) ? cloned : invalid('$', 'must be a plain object');

    if (candidate.protocol_version !== RUNTIME_PROTOCOL_VERSION) {
      invalid('protocol_version', `must equal ${RUNTIME_PROTOCOL_VERSION}`);
    }
    const requestId = candidate.request_id;
    if (typeof requestId !== 'string' || !requestId.trim()) {
      invalid('request_id', 'must be a non-empty string');
    }
    const command = candidate.command;
    if (typeof command !== 'string' || !command.trim()) {
      invalid('command', 'must be a non-empty string');
    }
    if (!isPlainObject(candidate.payload)) invalid('payload', 'must be a plain object');

    return candidate as CommandEnvelope;
  }
}
