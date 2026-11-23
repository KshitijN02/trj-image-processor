import { useState } from 'react';
import { formatBytes, percentSaved } from '../app/format';
import type { Item } from '../app/items';
import { pictureSnippet } from '../core/naming';
import { CompareSlider } from './CompareSlider';

interface Props {
  item: Item;
  stale: boolean;
  onRemove: () => void;
  onRetry: () => void;
}

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'teal' | 'amber' | 'red' | 'violet' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    teal: 'bg-teal-50 text-teal-800 ring-1 ring-teal-200',
    amber: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    red: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    violet: 'bg-violet-50 text-violet-800 ring-1 ring-violet-200',
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

export function FileCard({ item, stale, onRemove, onRetry }: Props) {
  const { report } = item;
  const [compareIdx, setCompareIdx] = useState<number | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [copied, setCopied] = useState(false);

  const outputs = report?.outputs ?? [];
  const mainIdx = outputs.map((o, i) => [o, i] as const).filter(([o]) => !o.variant);
  const thumb = mainIdx.length ? item.outputUrls[mainIdx[0][1]] : item.beforeUrl;
  const p = report?.processed;
  const snippet = pictureSnippet(outputs);

  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex gap-4 p-4">
        <div className="checker h-20 w-20 flex-none overflow-hidden rounded-lg border border-slate-200">
          {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-medium" title={item.file.name}>
              {item.file.name}
            </h3>
            <button type="button" onClick={onRemove} className="text-slate-400 hover:text-slate-700" aria-label="Remove">
              ✕
            </button>
          </div>
          <div className="text-sm text-slate-500">
            {formatBytes(item.file.size)}
            {item.width ? ` · ${report?.input.width ?? item.width}×${report?.input.height ?? item.height}` : ''}
            {item.format ? ` · ${item.format.toUpperCase()}` : ''}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {item.status === 'done' && report?.status === 'passthrough' && <Badge tone="amber">Animated: passed through</Badge>}
            {p && <Badge tone={p.kind === 'photo' ? 'teal' : 'violet'}>{p.kind}</Badge>}
            {p && <Badge>{p.resized ? `resized → ${p.width}×${p.height}` : 'not resized'}</Badge>}
            {p && <Badge>{p.denoised ? `denoised (σ ${p.noiseSigma})` : `no denoise (σ ${p.noiseSigma})`}</Badge>}
            {p && <Badge>{p.sharpened ? 'sharpened' : 'not sharpened'}</Badge>}
            {p && <Badge>{p.hasAlpha ? 'transparency kept' : 'opaque (no alpha)'}</Badge>}
            {p && <Badge>SSIM ≥ {p.threshold}</Badge>}
            {stale && item.status === 'done' && <Badge tone="amber">settings changed</Badge>}
          </div>
        </div>
      </div>

      {(item.status === 'queued' || item.status === 'processing') && (
        <div className="px-4 pb-4">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>{item.status === 'queued' ? 'Waiting…' : item.stage}</span>
            <span>{Math.round(item.progress * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${Math.max(3, item.progress * 100)}%` }} />
          </div>
        </div>
      )}

      {(item.status === 'error' || item.status === 'rejected') && (
        <div className="mx-4 mb-4 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>{item.error}</span>
          {item.status === 'error' && (
            <button type="button" onClick={onRetry} className="flex-none font-medium underline">
              Retry
            </button>
          )}
        </div>
      )}

      {report && report.warnings.length > 0 && (
        <ul className="mx-4 mb-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {report.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {outputs.length > 0 && (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-2 py-2 font-medium">Size</th>
                <th className="px-2 py-2 font-medium">Saved</th>
                <th className="px-2 py-2 font-medium">Dimensions</th>
                <th className="px-2 py-2 font-medium">Encoding</th>
                <th className="px-2 py-2 font-medium">SSIM</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {outputs.map((o, i) => (
                <tr key={o.name + i} className={o.variant ? 'text-slate-500' : ''}>
                  <td className="px-4 py-2 font-mono text-xs">
                    {o.name}
                    {o.sizeCapped && (
                      <span className="ml-2" title={o.note}>
                        <Badge tone="amber">size-capped</Badge>
                      </span>
                    )}
                    {o.keptOriginal && o.format !== 'gif' && (
                      <span className="ml-2">
                        <Badge tone="teal">Already optimal</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 tabular-nums">{formatBytes(o.bytes.length)}</td>
                  <td className="px-2 py-2 tabular-nums">{o.variant ? '–' : percentSaved(item.file.size, o.bytes.length)}</td>
                  <td className="px-2 py-2 tabular-nums">
                    {o.width}×{o.height}
                  </td>
                  <td className="px-2 py-2" title={o.note}>
                    {o.modeLabel}
                  </td>
                  <td className={`px-2 py-2 tabular-nums ${o.thresholdMet ? '' : 'text-amber-700'}`}>
                    {o.ssim === null ? '–' : o.ssim.toFixed(4)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {!o.variant && o.format !== 'gif' && item.beforeUrl && (
                      <button
                        type="button"
                        className="mr-3 text-teal-700 hover:underline"
                        onClick={() => setCompareIdx(compareIdx === i ? null : i)}
                      >
                        {compareIdx === i ? 'Hide' : 'Compare'}
                      </button>
                    )}
                    <button type="button" className="font-medium text-teal-700 hover:underline" onClick={() => download(item.outputUrls[i], o.name)}>
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {compareIdx !== null && item.beforeUrl && outputs[compareIdx] && (
        <div className="border-t border-slate-100 p-4">
          <CompareSlider
            before={item.beforeUrl}
            after={item.outputUrls[compareIdx]}
            width={outputs[compareIdx].width}
            height={outputs[compareIdx].height}
            transparent={p?.hasAlpha}
          />
        </div>
      )}

      {report?.status === 'done' && snippet && (
        <div className="border-t border-slate-100 px-4 py-2">
          <button type="button" className="text-sm text-teal-700 hover:underline" onClick={() => setShowSnippet(!showSnippet)}>
            {showSnippet ? 'Hide' : 'Show'} &lt;picture&gt; snippet
          </button>
          {showSnippet && (
            <div className="relative mt-2">
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{snippet}</pre>
              <button
                type="button"
                className="absolute right-2 top-2 rounded bg-white/10 px-2 py-0.5 text-xs text-white hover:bg-white/20"
                onClick={() => {
                  void navigator.clipboard.writeText(snippet).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
