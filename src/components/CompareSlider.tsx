import { useRef, useState, type PointerEvent } from 'react';

interface Props {
  before: string;
  after: string;
  width: number;
  height: number;
  transparent?: boolean;
}

/** Before/after wipe. "Fit" scales to the card; "100%" shows output pixels 1:1 (scroll to pan). */
export function CompareSlider({ before, after, width, height, transparent }: Props) {
  const [pos, setPos] = useState(50);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const dragging = useRef(false);

  const update = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };

  const stage = (
    <div
      className={`relative select-none touch-none ${transparent ? 'checker' : 'bg-slate-200'}`}
      style={zoom === 'fit' ? { aspectRatio: `${width} / ${height}`, width: '100%' } : { width, height }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => dragging.current && update(e)}
      onPointerUp={() => (dragging.current = false)}
    >
      <img src={after} alt="After" draggable={false} className="absolute inset-0 h-full w-full" style={{ imageRendering: zoom === 'actual' ? 'pixelated' : 'auto' }} />
      <img
        src={before}
        alt="Before"
        draggable={false}
        className="absolute inset-0 h-full w-full"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)`, imageRendering: zoom === 'actual' ? 'pixelated' : 'auto' }}
      />
      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" style={{ left: `${pos}%` }} />
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">Before</span>
      <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">After</span>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs">
          {(['fit', 'actual'] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`rounded-md px-2 py-0.5 ${zoom === z ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {z === 'fit' ? 'Fit' : '100% pixels'}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Comparison position"
          className="flex-1 accent-teal-700"
        />
      </div>
      {zoom === 'fit' ? (
        <div className="overflow-hidden rounded-lg">{stage}</div>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200">{stage}</div>
      )}
    </div>
  );
}
