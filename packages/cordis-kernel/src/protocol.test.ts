import { describe, expect, it } from 'vitest';

import { CommandEnvelopeCodec } from './index';
import type { CommandEnvelope } from './protocol';

const complete: CommandEnvelope = {
  protocol_version: 'runtime.v1',
  request_id: 'request-1',
  command: 'run.start',
  payload: { message: 'hello' },
};

const codec = new CommandEnvelopeCodec();

const expectInvalid = (operation: () => unknown, path: string) => {
  try {
    operation();
    throw new Error('expected protocol validation failure');
  } catch (error) {
    expect(error).toMatchObject({ code: 'PROTOCOL_INVALID', path });
  }
};

describe('@lobechat/cordis-kernel CommandEnvelopeCodec', () => {
  it('validates a complete runtime.v1 command envelope', () => {
    expect(codec.validate(complete)).toEqual(complete);
  });

  it('reports the path of missing required fields', () => {
    expectInvalid(
      () => codec.validate({ command: complete.command, payload: complete.payload }),
      'protocol_version',
    );
    expectInvalid(
      () => codec.validate({ protocol_version: 'runtime.v1', payload: complete.payload }),
      'request_id',
    );
    expectInvalid(
      () =>
        codec.validate({ protocol_version: 'runtime.v1', request_id: 'request-1', payload: {} }),
      'command',
    );
    expectInvalid(
      () =>
        codec.validate({ protocol_version: 'runtime.v1', request_id: 'request-1', command: 'x' }),
      'payload',
    );
  });

  it('rejects protocol versions other than runtime.v1', () => {
    expectInvalid(
      () => codec.validate({ ...complete, protocol_version: 'runtime.v0' }),
      'protocol_version',
    );
  });

  it('rejects empty request_id and command values', () => {
    expectInvalid(() => codec.validate({ ...complete, request_id: '   ' }), 'request_id');
    expectInvalid(() => codec.validate({ ...complete, command: '' }), 'command');
  });

  it('requires payload to be a plain object', () => {
    expectInvalid(() => codec.validate({ ...complete, payload: null }), 'payload');
    expectInvalid(() => codec.validate({ ...complete, payload: [] }), 'payload');
    expectInvalid(() => codec.validate({ ...complete, payload: new Date() }), 'payload');
  });

  it('preserves unknown payload fields', () => {
    const input = {
      ...complete,
      payload: {
        unknownFlag: true,
        nested: { providerValue: 7 },
      },
    };

    expect(codec.validate(input).payload).toEqual(input.payload);
  });

  it('round-trips an envelope through encode and decode', () => {
    const encoded = codec.encode({
      ...complete,
      payload: { values: [1, 2, 3], unknown: { enabled: true } },
    });

    expect(codec.decode(encoded)).toEqual({
      ...complete,
      payload: { values: [1, 2, 3], unknown: { enabled: true } },
    });
  });

  it('reports nested field paths for invalid payload values', () => {
    expectInvalid(
      () =>
        codec.encode({
          ...complete,
          payload: { options: { callback: () => 'not data' } },
        }),
      'payload.options.callback',
    );
  });

  it('does not execute payload functions during encoding', () => {
    let called = false;
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, 'toJSON', {
      enumerable: true,
      value: () => {
        called = true;
        return { changed: true };
      },
    });

    expectInvalid(() => codec.encode({ ...complete, payload }), 'payload.toJSON');
    expect(called).toBe(false);
  });
});
