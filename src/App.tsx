import * as Comlink from 'comlink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DISPLAYABLE, revokeItemUrls, type Item } from './app/items';
import { getPool } from './app/processor';
import { Dropzone } from './components/Dropzone';
import { FileCard } from './components/FileCard';
import { SettingsPanel } from './components/SettingsPanel';
import { Summary } from './components/Summary';
import { admit } from './core/limits';
import { pictureSnippet } from './core/naming';
import { DEFAULT_SETTINGS, MAX_FILE_BYTES } from './core/settings';
import type { ProcessReport, Settings } from './core/types';

const SETTINGS_KEY = 'image-optimiser:settings';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SETTINGS;
}

const keyOf = (s: Settings) => JSON.stringify(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [items, setItems] = useState<Item[]>([]);
  const [zipping, setZipping] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const settingsKey = keyOf(settings);
  const isolated = typeof window !== 'undefined' && window.crossOriginIsolated === true;

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => () => itemsRef.current.forEach(revokeItemUrls), []);

  const update = useCallback((id: string, patch: Partial<Item> | ((it: Item) => Partial<Item>)) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)));
  }, []);

  const process = useCallback(
    (item: Item, s: Settings) => {
      const mp = ((item.width ?? 0) * (item.height ?? 0)) / 1e6;
      const key = keyOf(s);
      update(item.id, { status: 'queued', progress: 0, stage: 'Waiting', error: undefined });
      getPool()
        .run(mp, async (api) => {
          update(item.id, { status: 'processing', stage: 'Reading file', progress: 0.01 });
          const buf = await item.file.arrayBuffer();
          return api.process(
            item.file.name,
            Comlink.transfer(buf, [buf]),
            s,
            Comlink.proxy((stage: string, progress: number) => update(item.id, { stage, progress })),
          );
        })
        .then((report: ProcessReport) => {
          if (!itemsRef.current.some((i) => i.id === item.id)) return; // removed meanwhile
          const outputUrls = report.outputs.map((o) => URL.createObjectURL(new Blob([o.bytes as BlobPart], { type: o.mime })));
          update(item.id, (it) => {
            for (const u of it.outputUrls) URL.revokeObjectURL(u);
            let beforeUrl = it.beforeUrl;
            if (!beforeUrl && report.beforePreview) {
              beforeUrl = URL.createObjectURL(new Blob([report.beforePreview as BlobPart], { type: 'image/jpeg' }));
            }
            return { status: 'done', progress: 1, stage: 'Done', report, outputUrls, beforeUrl, settingsKey: key };
          });
        })
        .catch((err: unknown) => {
          update(item.id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
        });
    },
    [update],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const s = settings;
      for (const file of files) {
        const base: Item = { id: uid(), file, status: 'queued', stage: 'Checking', progress: 0, outputUrls: [] };
        if (file.size > MAX_FILE_BYTES) {
          setItems((p) => [...p, { ...base, status: 'rejected', error: `File is ${(file.size / 1048576).toFixed(1)} MB; the limit is 50 MB.` }]);
          continue;
        }
        // Sniff from the first 1 MB; fall back to the whole file if the header lies deeper.
        let adm = admit(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
        if (!adm.ok && file.size > 1 << 20) adm = admit(new Uint8Array(await file.arrayBuffer()));
        if (!adm.ok) {
          setItems((p) => [...p, { ...base, status: 'rejected', error: adm.reason }]);
          continue;
        }
        const item: Item = {
          ...base,
          format: adm.format,
          width: adm.width,
          height: adm.height,
          beforeUrl: DISPLAYABLE.includes(adm.format) ? URL.createObjectURL(file) : undefined,
        };
        setItems((p) => [...p, item]);
        process(item, s);
      }
    },
    [settings, process],
  );

  const remove = (id: string) => {
    const it = itemsRef.current.find((i) => i.id === id);
    if (it) revokeItemUrls(it);
    setItems((p) => p.filter((i) => i.id !== id));
  };

  const clearAll = () => {
    getPool().clearQueue();
    itemsRef.current.forEach(revokeItemUrls);
    setItems([]);
  };

  const staleItems = useMemo(
    () => items.filter((i) => (i.status === 'done' || i.status === 'error') && i.settingsKey !== settingsKey),
    [items, settingsKey],
  );
  const busy = items.some((i) => i.status === 'queued' || i.status === 'processing');

  const downloadAll = async () => {
    setZipping(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const used = new Set<string>();
      const snippets: string[] = [];
      for (const it of itemsRef.current) {
        if (it.status !== 'done' || !it.report) continue;
        for (const o of it.report.outputs) {
          let name = o.name;
          for (let n = 2; used.has(name); n++) name = o.name.replace(/(\.[^.]+)$/, `_${n}$1`);
          used.add(name);
          zip.file(name, o.bytes, { binary: true });
        }
        if (it.report.status === 'done') {
          snippets.push(`<!-- ${it.file.name} -->\n${pictureSnippet(it.report.outputs)}`);
        }
      }
      if (snippets.length) zip.file('picture-snippets.html', snippets.join('\n\n') + '\n');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'optimised-images.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Image Optimiser</h1>
          <p className="text-sm text-slate-500">
            Resize, clean up and convert to AVIF/WebP at the lowest quality that still passes an SSIM check. Everything runs in your browser.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs ${isolated ? 'bg-teal-50 text-teal-800' : 'bg-slate-100 text-slate-600'}`}
          title={isolated ? 'SharedArrayBuffer available: multi-threaded AVIF/oxipng' : 'Not cross-origin isolated: single-threaded codecs'}
        >
          {isolated ? 'Multi-threaded codecs' : 'Single-threaded codecs'}
        </span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <SettingsPanel settings={settings} onChange={setSettings} />
        </aside>

        <main className="min-w-0 space-y-4">
          <Dropzone onFiles={(f) => void addFiles(f)} />

          {staleItems.length > 0 && !busy && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <span>Settings changed since {staleItems.length === 1 ? 'one file was' : `${staleItems.length} files were`} processed.</span>
              <button type="button" className="font-medium underline" onClick={() => staleItems.forEach((i) => process(i, settings))}>
                Re-process with new settings
              </button>
            </div>
          )}

          <Summary items={items} onDownloadAll={() => void downloadAll()} zipping={zipping} onClear={clearAll} />

          <div className="space-y-3">
            {items.map((it) => (
              <FileCard
                key={it.id}
                item={it}
                stale={it.settingsKey !== undefined && it.settingsKey !== settingsKey}
                onRemove={() => remove(it.id)}
                onRetry={() => process(it, settings)}
              />
            ))}
          </div>

          {!items.length && (
            <p className="text-center text-sm text-slate-500">
              No images yet. Test images are in <code className="rounded bg-slate-100 px-1">public/samples/</code>.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
