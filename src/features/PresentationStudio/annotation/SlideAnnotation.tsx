import { Button, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  PresentationMessageInput,
  PresentationSlidePlan,
} from '../../../../packages/runtime-contracts/src';
import { annotationElements } from '../../../../packages/utils/src/presentationAnnotation';
import { type ElementBox, measureAnnotationElements, selectAnnotationElements } from './geometry';

const styles = createStaticStyles(({ css }) => ({
  overlay: css`
    touch-action: none;
    cursor: crosshair;

    position: absolute;
    z-index: 5;
    inset: 0;
  `,
  selection: css`
    pointer-events: none;

    position: absolute;

    border: 1.5px solid #3478f6;
    border-radius: 5px;

    background: #3478f612;
  `,
  pin: css`
    position: absolute;
    transform: translate(-50%, -50%);

    display: grid;
    place-items: center;

    width: 26px;
    height: 26px;
    border: 2px solid white;
    border-radius: 50%;

    color: white;

    background: #222;
    box-shadow: 0 2px 8px #0003;
  `,
  capsule: css`
    cursor: auto;

    position: absolute;

    display: flex;
    gap: 6px;
    align-items: center;

    width: min(340px, 92%);
    padding-block: 7px;
    padding-inline: 16px 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 28px;

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 8px 28px #0002;
  `,
  input: css`
    width: 100%;
    min-width: 0;
    border: 0;

    font-size: 14px;
    color: ${cssVar.colorText};

    background: transparent;
    outline: none;
  `,
  hint: css`
    pointer-events: none;

    position: absolute;
    inset-block-start: 12px;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    padding-block: 7px;
    padding-inline: 16px;
    border-radius: 24px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 2px 12px #0001;
  `,
}));

export function SlideAnnotation({
  jobId,
  page,
  versionId,
  onSend,
  onClose,
}: {
  jobId: string;
  page: number;
  versionId: string;
  onSend: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const [data, setData] = useState<{
    slide: PresentationSlidePlan;
    hash: string;
    boxes: ElementBox[];
    versionId: string;
  }>();
  const [region, setRegion] = useState<Omit<ElementBox, 'index'>>();
  const [indices, setIndices] = useState<number[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const requestId = useRef(crypto.randomUUID());
  const openedVersion = useRef(versionId);
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setRegion(undefined);
    setIndices([]);
    setComment('');
    setError('');
    void (async () => {
      const response = await fetch('/api/runtime/presentation/tools/presentation.page.read', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, page }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '页面读取失败');
      if (body.versionId !== openedVersion.current) throw new Error('页面已更新，请重新打开标注');
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(body.slide.svg),
      );
      const boxes = measureAnnotationElements(body.slide.svg);
      if (boxes.length !== annotationElements(body.slide.svg).length)
        throw new Error('此页面的元素暂不支持精确标注');
      if (!controller.signal.aborted)
        setData({
          ...body,
          boxes,
          hash: Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        });
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [jobId, page]);
  useEffect(() => {
    const parent = overlayRef.current?.parentElement;
    if (!parent) return;
    const viewBox = data?.slide.svg
      .match(/viewBox=["']([^"']+)["']/)?.[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const ratio = viewBox ? viewBox[2] / viewBox[3] : 16 / 9;
    const resize = () => {
      const width = Math.min(parent.clientWidth, parent.clientHeight * ratio);
      const height = width / ratio;
      setViewport({
        width,
        height,
        left: (parent.clientWidth - width) / 2,
        top: (parent.clientHeight - height) / 2,
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [data]);
  const send = async () => {
    if (!data || !region || !indices.length || !comment.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const accepted = await onSend(jobId, {
        content: comment.trim(),
        requestId: requestId.current,
        target: { type: 'slide', slideNumber: page },
        annotation: {
          slideId: data.slide.slideId,
          expectedVersionId: data.versionId,
          baseSvgHash: data.hash,
          elementIndices: indices,
          region,
        },
      });
      if (accepted) onClose();
      else setError('未能发送，请重试或重新标注');
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };
  const coordinate = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  };
  return (
    <div
      aria-label="标注幻灯片"
      className={styles.overlay}
      ref={overlayRef}
      role="application"
      style={viewport}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      onPointerDown={(e) => {
        if (!data || sending) return;
        e.preventDefault();
        start.current = coordinate(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        setIndices([]);
        setRegion({ ...start.current, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const p = coordinate(e);
        setRegion({
          x: Math.min(p.x, start.current.x),
          y: Math.min(p.y, start.current.y),
          width: Math.abs(p.x - start.current.x),
          height: Math.abs(p.y - start.current.y),
        });
      }}
      onPointerUp={(e) => {
        if (!start.current || !data) return;
        const p = coordinate(e);
        const r = {
          x: Math.min(p.x, start.current.x),
          y: Math.min(p.y, start.current.y),
          width: Math.abs(p.x - start.current.x),
          height: Math.abs(p.y - start.current.y),
        };
        start.current = undefined;
        setRegion(r);
        const selected = selectAnnotationElements(data.boxes, r);
        setIndices(selected);
        requestId.current = crypto.randomUUID();
        setError(selected.length ? '' : '点选一个元素，或框住需要修改的内容');
      }}
    >
      {(!region || error || !data) && (
        <span className={styles.hint} role={error ? 'alert' : undefined}>
          {error || (data ? '点选或框选' : '正在读取页面…')}
        </span>
      )}
      {region && (
        <>
          <div
            className={styles.selection}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
          />
          <span
            className={styles.pin}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%` }}
          >
            1
          </span>
        </>
      )}
      {region && indices.length > 0 && (
        <form
          className={styles.capsule}
          style={{
            left: `clamp(4%, ${region.x * 100}%, calc(100% - 350px))`,
            top: `clamp(12px, calc(${region.y * 100}% + 22px), calc(100% - 56px))`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            autoFocus
            aria-label="局部修改意见"
            className={styles.input}
            disabled={sending}
            maxLength={4000}
            placeholder="这里怎么改？"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            aria-label="发送标注"
            disabled={!comment.trim() || sending}
            icon={<Icon icon={ArrowUp} size={20} />}
            loading={sending}
            shape="circle"
            type="primary"
            onClick={() => void send()}
          />
          <Button
            aria-label="取消标注"
            icon={<Icon icon={X} size={20} />}
            shape="circle"
            type="text"
            onClick={onClose}
          />
        </form>
      )}
    </div>
  );
}
