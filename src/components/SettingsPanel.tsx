import type { ReactNode } from 'react';
import { DEFAULT_MAX_FILE_KB, DEFAULT_SETTINGS, SSIM_THRESHOLDS } from '../core/settings';
import type { Settings } from '../core/types';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  disabled?: boolean;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-sm transition ${
            o.value === value ? 'bg-teal-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-teal-700"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      {children}
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function SettingsPanel({ settings: s, onChange, disabled }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...s, [k]: v });
  const t = SSIM_THRESHOLDS[s.safety];
  return (
    <fieldset disabled={disabled} className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Settings</h2>
        <button type="button" className="text-xs text-teal-700 hover:underline" onClick={() => onChange(DEFAULT_SETTINGS)}>
          Reset defaults
        </button>
      </div>

      <Row label="Longest edge cap" hint="Images are never upscaled.">
        <Segmented
          value={s.cap}
          onChange={(v) => set('cap', v)}
          options={[1920, 2560, 3000].map((v) => ({ value: v as Settings['cap'], label: `${v}px` }))}
        />
      </Row>

      <Row label="Quality safety" hint={`Minimum SSIM: photos ${t.photo}, graphics ${t.graphic}`}>
        <Segmented
          value={s.safety}
          onChange={(v) => set('safety', v)}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'high', label: 'High' },
            { value: 'maximum', label: 'Maximum' },
          ]}
        />
      </Row>

      <Row label="Clean-up">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-600">Denoise</span>
          <Segmented
            value={s.denoise}
            onChange={(v) => set('denoise', v)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </div>
        <Toggle checked={s.sharpen} onChange={(v) => set('sharpen', v)} label="Light sharpen after resize" hint="Skipped when the image isn't resized." />
      </Row>

      <Row label="Output formats" hint="For JPEG, PNG and HEIC inputs. WebP and AVIF inputs keep their format.">
        <div className="flex gap-4">
          <Toggle
            checked={s.modernFormats.avif}
            onChange={(v) => (v || s.modernFormats.webp) && set('modernFormats', { ...s.modernFormats, avif: v })}
            label="AVIF"
          />
          <Toggle
            checked={s.modernFormats.webp}
            onChange={(v) => (v || s.modernFormats.avif) && set('modernFormats', { ...s.modernFormats, webp: v })}
            label="WebP"
          />
        </div>
        <Toggle
          checked={s.fallback}
          onChange={(v) => set('fallback', v)}
          label="Also export a JPEG fallback"
          hint="For emails, PDFs and social previews. Graphics and transparent images get an optimised PNG instead."
        />
        <Toggle
          checked={s.alsoOtherModern}
          onChange={(v) => set('alsoOtherModern', v)}
          label="Also create the other modern format"
          hint="WebP inputs also get AVIF, and AVIF inputs also get WebP."
        />
      </Row>

      <Row label="Responsive sizes">
        <Toggle
          checked={s.responsive}
          onChange={(v) => set('responsive', v)}
          label="Export 400 / 800 / 1600 px widths"
          hint="Only widths smaller than the processed image, plus a <picture> snippet."
        />
      </Row>

      <Row
        label="File size limit"
        hint={
          s.maxFileKB
            ? `Every output file will be under ${s.maxFileKB} KB (${(s.maxFileKB * 1000).toLocaleString()} bytes). Quality may drop below the safety threshold, and large images are downscaled if needed.`
            : 'Off: quality safety comes first, whatever the file size.'
        }
      >
        <Toggle
          checked={s.maxFileKB !== null}
          onChange={(v) => set('maxFileKB', v ? DEFAULT_MAX_FILE_KB : null)}
          label="Allow a quality compromise to stay under a size limit"
        />
        {s.maxFileKB !== null && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">Max size</span>
            <input
              type="number"
              min={5}
              max={5000}
              step={5}
              value={s.maxFileKB}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (Number.isFinite(v) && v >= 5 && v <= 5000) set('maxFileKB', v);
              }}
              className="w-24 rounded-md border border-slate-300 px-2 py-1 tabular-nums"
            />
            <span className="text-slate-600">KB</span>
          </label>
        )}
      </Row>

      <Row label="AVIF encoder speed" hint="Lower is slower, but files come out a little smaller.">
        <Segmented
          value={s.avifSpeed}
          onChange={(v) => set('avifSpeed', v)}
          options={[4, 5, 6].map((v) => ({ value: v as Settings['avifSpeed'], label: String(v) }))}
        />
      </Row>
    </fieldset>
  );
}
