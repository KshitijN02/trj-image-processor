import { formatBytes, percentSaved } from '../app/format';
import type { Item } from '../app/items';

interface Props {
  items: Item[];
  onDownloadAll: () => void;
  zipping: boolean;
  onClear: () => void;
}

export function Summary({ items, onDownloadAll, zipping, onClear }: Props) {
  const done = items.filter((i) => i.status === 'done' && i.report);
  const busy = items.filter((i) => i.status === 'queued' || i.status === 'processing').length;
  const failed = items.filter((i) => i.status === 'error' || i.status === 'rejected').length;

  let before = 0;
  let after = 0;
  const perFormat = new Map<string, { before: number; after: number; count: number }>();
  for (const it of done) {
    const main = it.report!.outputs.filter((o) => !o.variant);
    if (!main.length) continue;
    before += it.file.size;
    // What a modern browser actually downloads: the smallest main output.
    after += Math.min(...main.map((o) => o.bytes.length));
    for (const o of main) {
      const f = perFormat.get(o.format) ?? { before: 0, after: 0, count: 0 };
      f.before += it.file.size;
      f.after += o.bytes.length;
      f.count++;
      perFormat.set(o.format, f);
    }
  }

  if (!items.length) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-6">
          <Stat label="Processed" value={`${done.length} / ${items.length}`} sub={[busy && `${busy} in progress`, failed && `${failed} failed`].filter(Boolean).join(' · ') || undefined} />
          <Stat label="Before" value={formatBytes(before)} />
          <Stat label="After (smallest format)" value={formatBytes(after)} />
          <Stat label="Saved" value={percentSaved(before, after)} accent />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Clear all
          </button>
          <button
            type="button"
            disabled={!done.length || zipping}
            onClick={onDownloadAll}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-teal-800 disabled:opacity-40"
          >
            {zipping ? 'Zipping…' : 'Download all (ZIP)'}
          </button>
        </div>
      </div>
      {perFormat.size > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
          {[...perFormat].map(([f, v]) => (
            <span key={f}>
              <span className="font-semibold uppercase text-slate-700">{f}</span> {formatBytes(v.after)} total ({percentSaved(v.before, v.after)} across {v.count})
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${accent ? 'text-teal-700' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
