import { ReactNode, RefObject, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Info } from 'lucide-react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { toBlob } from 'html-to-image';

/**
 * Hover-triggered floating info card — replaces the native `title` attribute
 * tooltip (which truncates/overlaps awkwardly for anything longer than a
 * sentence). Rendered via a portal to document.body so it's never clipped by
 * a parent's overflow:hidden (e.g. the mini trajectory cards), and clamped
 * to the viewport so it never runs off-screen.
 */
export function InfoPopover({ children, width = 420 }: { children: ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const show = () => {
    clearCloseTimer();
    const rect = iconRef.current?.getBoundingClientRect();
    if (rect) {
      const margin = 12;
      let left = rect.left;
      if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin);
      let top = rect.bottom + 6;
      const maxHeight = window.innerHeight - top - margin;
      if (maxHeight < 160) top = Math.max(margin, rect.top - 6 - 160);
      setPos({ top, left });
    }
    setOpen(true);
  };

  const scheduleHide = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <span
      ref={iconRef}
      className="statInfoTrigger"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
      tabIndex={0}
    >
      <Info size={11} />
      {open && pos
        ? createPortal(
            <div
              className="statInfoCard"
              style={{ top: pos.top, left: pos.left, width }}
              onMouseEnter={clearCloseTimer}
              onMouseLeave={scheduleHide}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}

/** One properly-typeset LaTeX formula line (via KaTeX). `displayMode` renders it as its own
 * centered block; inline mode sits within a sentence. A small button lets
 * the researcher copy the rendered formula as a PNG (e.g. to paste into a
 * paper/slide) — rasterized client-side via html-to-image, no server round trip. */
export function Tex({ tex, displayMode = true }: { tex: string; displayMode?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false, displayMode }),
    [tex, displayMode],
  );
  const formulaRef = useRef<HTMLSpanElement | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'done' | 'error'>('idle');

  async function copyAsPng() {
    if (!formulaRef.current || copyState === 'copying') return;
    setCopyState('copying');
    try {
      const blob = await toBlob(formulaRef.current, { pixelRatio: 3 });
      if (!blob) throw new Error('rasterization failed');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopyState('done');
    } catch {
      setCopyState('error');
    } finally {
      setTimeout(() => setCopyState('idle'), 1600);
    }
  }

  return (
    <span className="texFormulaWrap">
      <span className="texFormula" ref={formulaRef} dangerouslySetInnerHTML={{ __html: html }} />
      <button
        type="button"
        className="texCopyBtn"
        onClick={copyAsPng}
        title={copyState === 'error' ? 'Copy failed — your browser may block clipboard image access' : 'Copy this formula as a PNG image'}
      >
        {copyState === 'done' ? <Check size={12} /> : <Copy size={12} />}
        {copyState === 'copying' ? 'Copying…' : copyState === 'done' ? 'Copied' : copyState === 'error' ? 'Failed' : 'Copy as PNG'}
      </button>
    </span>
  );
}

async function copyElementAsPng(el: HTMLElement, pixelRatio = 2): Promise<boolean> {
  const blob = await toBlob(el, { pixelRatio });
  if (!blob) return false;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

/** Small "Copy as PNG" button for any DOM node — a table, a chart, a whole
 * card — for pasting straight into a slide deck. Same client-side
 * rasterization (html-to-image) + clipboard-write as the Tex formula copy
 * button above, generalized to an arbitrary target ref instead of only the
 * formula's own span. */
export function CopyAsPngButton({
  targetRef, label = 'Copy as PNG', className = 'copyPngBtn',
}: {
  targetRef: RefObject<HTMLElement | null>;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'done' | 'error'>('idle');

  async function handleClick() {
    if (!targetRef.current || state === 'copying') return;
    setState('copying');
    try {
      const ok = await copyElementAsPng(targetRef.current);
      setState(ok ? 'done' : 'error');
    } catch {
      setState('error');
    } finally {
      setTimeout(() => setState('idle'), 1600);
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      title={state === 'error' ? 'Copy failed — your browser may block clipboard image access' : `${label} to clipboard`}
    >
      {state === 'done' ? <Check size={13} /> : <Copy size={13} />}
      {state === 'copying' ? 'Copying…' : state === 'done' ? 'Copied' : state === 'error' ? 'Failed' : label}
    </button>
  );
}

export function InfoSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="statInfoSection">
      <h5>{heading}</h5>
      {children}
    </div>
  );
}
