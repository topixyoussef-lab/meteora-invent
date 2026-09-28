import { useCallback, useEffect, useMemo, useState } from 'react';
import { CollectFeeMode, MigrationOption, TokenType } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  CURVE_PRESETS,
  FEE_SCHEDULES,
  FEE_SCHEDULE_LABEL,
  MAX_MIGRATION_FEE_PERCENTAGE,
  MIGRATION_FEE_OPTION_LABEL,
  MIN_FEE_BPS,
  MIN_LOCKED_LIQUIDITY_PERCENTAGE,
  SELECTABLE_MIGRATION_FEE_OPTIONS,
  SECONDS_PER_DAY,
  generateCurveParams,
  presetInputSchema,
  type CurvePreview,
  type CurvePresetId,
  type PresetInput,
} from '@/lib/meteora';

type BondingCurveConfiguratorProps = {
  presetId: CurvePresetId;
  input: PresetInput;
  onChange: (presetId: CurvePresetId, input: PresetInput) => void;
  disabled?: boolean;
};

type NumericFieldProps = {
  label: string;
  hint?: string;
  suffix?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
};

function NumberField({
  label,
  hint,
  suffix,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: NumericFieldProps) {
  const invalid = (min !== undefined && value < min) || (max !== undefined && value > max);

  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-neutral-300">{label}</span>
        {hint ? <span className="text-2xs text-neutral-500">{hint}</span> : null}
      </span>
      <span className="relative block">
        <input
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            // Ignore transient empty/NaN input rather than writing NaN into state.
            if (Number.isFinite(next)) onChange(next);
          }}
          className={cn(
            'w-full rounded-lg border bg-background px-3 py-2 pr-12 text-sm text-foreground',
            'transition-colors focus:outline-none focus:ring-1 disabled:opacity-50',
            invalid
              ? 'border-rose/60 focus:border-rose focus:ring-rose/40'
              : 'border-neutral-750 focus:border-primary/60 focus:ring-primary/40'
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-neutral-500">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-neutral-300">{label}</span>
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className="w-full rounded-lg border border-neutral-750 bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-neutral-850 bg-background/60 px-3 py-2.5">
      <p className="text-2xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-mono text-sm tabular-nums',
          tone === 'good' && 'text-emerald',
          tone === 'warn' && 'text-amber',
          tone === 'default' && 'text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Live bonding-curve configurator.
 *
 * Every keystroke re-runs the real `buildCurve*` builder from the DBC SDK, so
 * the numbers shown are the exact `ConfigParameters` that will be submitted —
 * not an approximation. Builder throws are surfaced inline instead of being
 * swallowed, because the SDK rejects several parameter combinations outright.
 */
export function BondingCurveConfigurator({
  presetId,
  input,
  onChange,
  disabled = false,
}: BondingCurveConfiguratorProps) {
  const [preview, setPreview] = useState<CurvePreview | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [schemaErrors, setSchemaErrors] = useState<string[]>([]);

  const update = useCallback(
    (patch: Partial<PresetInput>) => onChange(presetId, { ...input, ...patch }),
    [input, onChange, presetId]
  );

  const selectPreset = useCallback(
    (nextId: CurvePresetId) => {
      onChange(nextId, { ...CURVE_PRESETS[nextId].defaults });
    },
    [onChange]
  );

  // Recompute on every change. Cheap (pure arithmetic, no RPC) and it keeps the
  // readout honest: what you see is exactly what gets submitted on-chain.
  useEffect(() => {
    const parsed = presetInputSchema.safeParse(input);
    if (!parsed.success) {
      setSchemaErrors(parsed.error.issues.map((i) => i.message));
      setPreview(null);
      setBuilderError(null);
      return;
    }

    setSchemaErrors([]);
    try {
      setPreview(generateCurveParams(presetId, parsed.data));
      setBuilderError(null);
    } catch (error) {
      setPreview(null);
      setBuilderError(error instanceof Error ? error.message : String(error));
    }
  }, [presetId, input]);

  const lpTotal = useMemo(
    () =>
      input.partnerLiquidityPercentage +
      input.partnerPermanentLockedLiquidityPercentage +
      input.creatorLiquidityPercentage +
      input.creatorPermanentLockedLiquidityPercentage,
    [
      input.creatorLiquidityPercentage,
      input.creatorPermanentLockedLiquidityPercentage,
      input.partnerLiquidityPercentage,
      input.partnerPermanentLockedLiquidityPercentage,
    ]
  );

  const lockedTotal =
    input.partnerPermanentLockedLiquidityPercentage +
    input.creatorPermanentLockedLiquidityPercentage;

  const isRateLimiter = input.feeSchedule === 'rateLimiter';
  const usesMarketCap = presetId !== 'flat';

  return (
    <div className="space-y-4">
      {/* ----------------------------- Preset picker ---------------------------- */}
      <div>
        <h3 className="mb-1.5 text-sm font-semibold text-foreground">Curve profile</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {Object.values(CURVE_PRESETS).map((preset) => {
            const active = preset.id === presetId;
            return (
              <button
                key={preset.id}
                type="button"
                disabled={disabled}
                onClick={() => selectPreset(preset.id)}
                aria-pressed={active}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors disabled:opacity-50',
                  active
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-neutral-800 bg-background/60 hover:border-neutral-700'
                )}
              >
                <p
                  className={cn(
                    'text-sm font-semibold',
                    active ? 'text-primary-200' : 'text-foreground'
                  )}
                >
                  {preset.label}
                </p>
                <p className="mt-1 text-2xs leading-relaxed text-neutral-500">
                  {preset.tagline}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* --------------------------- Derived readouts --------------------------- */}
      <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Live curve parameters</h3>
          {preview ? (
            <span className="rounded-full bg-emerald/15 px-2 py-0.5 text-2xs font-medium text-emerald">
              SDK-validated
            </span>
          ) : (
            <span className="rounded-full bg-rose/15 px-2 py-0.5 text-2xs font-medium text-rose">
              Invalid
            </span>
          )}
        </div>

        {builderError ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose/40 bg-rose/10 p-3">
            <span className="iconify mt-0.5 h-4 w-4 shrink-0 text-rose ph--warning-circle-bold" />
            <p className="text-xs leading-relaxed text-rose">
              DBC SDK rejected these parameters: {builderError}
            </p>
          </div>
        ) : null}

        {schemaErrors.length > 0 ? (
          <ul className="mb-3 space-y-1">
            {schemaErrors.map((message) => (
              <li key={message} className="flex items-start gap-2 text-xs text-amber">
                <span className="iconify mt-0.5 h-3.5 w-3.5 shrink-0 ph--info-bold" />
                {message}
              </li>
            ))}
          </ul>
        ) : null}

        {preview ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat
              label="Start price"
              value={`${preview.startingPrice.toExponential(3)} SOL`}
            />
            <Stat
              label="Graduation price"
              value={`${preview.migrationPrice.toExponential(3)} SOL`}
            />
            <Stat label="Price multiple" value={`${preview.priceMultiple.toFixed(2)}x`} />
            <Stat
              label="Migration threshold"
              value={`${preview.migrationQuoteThresholdSol.toFixed(2)} SOL`}
              tone="warn"
            />
            <Stat label="Curve segments" value={String(preview.segments)} />
            <Stat
              label="Graduation"
              value={`${preview.migrationTarget} · ${preview.migrationFeeLabel}`}
            />
            <Stat
              label="On-curve supply"
              value={`${(preview.preMigrationSupply / 1e6).toFixed(1)}M`}
            />
            <Stat
              label="Post-migration"
              value={`${(preview.postMigrationSupply / 1e6).toFixed(1)}M`}
            />
            <Stat
              label="LP permanently locked"
              value={`${preview.permanentLockedPercentage}%`}
              tone={preview.protocolLockedRuleSatisfied ? 'good' : 'warn'}
            />
          </div>
        ) : null}

        {preview ? (
          <p className="mt-3 text-2xs leading-relaxed text-neutral-500">
            Computed by <span className="font-mono">generateCurveParams()</span> from the Meteora DBC
            SDK. These are the exact <span className="font-mono">ConfigParameters</span> submitted
            in the launch transaction.
          </p>
        ) : null}
      </div>

      {/* --------------------------- Token metrics ----------------------------- */}
      <Section title="Token metrics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label="Total supply"
            hint="human units"
            suffix="TOK"
            value={input.totalTokenSupply}
            min={1}
            step={1_000_000}
            disabled={disabled}
            onChange={(v) => update({ totalTokenSupply: Math.round(v) })}
          />
          <NumberField
            label="Unsold leftover"
            hint="claimable post-migration"
            suffix="TOK"
            value={input.leftover}
            min={0}
            step={1_000_000}
            disabled={disabled}
            onChange={(v) => update({ leftover: Math.round(v) })}
          />
          <SelectField
            label="Base decimals"
            value={input.tokenBaseDecimal}
            options={[6, 7, 8, 9].map((d) => ({ value: d, label: String(d) }))}
            disabled={disabled}
            onChange={(v) => update({ tokenBaseDecimal: v })}
          />
          <SelectField
            label="Token standard"
            value={input.tokenType}
            options={[
              { value: TokenType.SPLToken, label: 'SPL Token' },
              { value: TokenType.Token2022, label: 'Token-2022' },
            ]}
            disabled={disabled}
            onChange={(v) => update({ tokenType: v })}
          />
        </div>
      </Section>

      {/* --------------------------- Curve shape ------------------------------- */}
      <Section
        title="Curve shape"
        subtitle={
          presetId === 'flat'
            ? 'Priced from a direct migration quote threshold.'
            : presetId === 'exponential'
              ? 'Explicit geometric price ladder across segments.'
              : 'Anchored to market caps at launch and at graduation.'
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {presetId === 'flat' ? (
            <>
              <NumberField
                label="Supply on migration"
                suffix="%"
                value={input.percentageSupplyOnMigration}
                min={1}
                max={100}
                disabled={disabled}
                onChange={(v) => update({ percentageSupplyOnMigration: v })}
              />
              <NumberField
                label="Migration quote threshold"
                hint="SOL needed to graduate"
                suffix="SOL"
                value={input.migrationQuoteThreshold}
                min={0.001}
                step={1}
                disabled={disabled}
                onChange={(v) => update({ migrationQuoteThreshold: v })}
              />
            </>
          ) : (
            <>
              <NumberField
                label="Initial market cap"
                suffix="SOL"
                value={input.initialMarketCap}
                min={0.01}
                step={1}
                disabled={disabled}
                onChange={(v) => update({ initialMarketCap: v })}
              />
              <NumberField
                label="Graduation market cap"
                suffix="SOL"
                value={input.migrationMarketCap}
                min={0.01}
                step={10}
                disabled={disabled}
                onChange={(v) => update({ migrationMarketCap: v })}
              />
            </>
          )}

          {presetId === 'exponential' ? (
            <>
              <NumberField
                label="Price ramp"
                hint="per segment"
                suffix="x"
                value={input.exponentialRamp}
                min={1.1}
                max={4}
                step={0.05}
                disabled={disabled}
                onChange={(v) => update({ exponentialRamp: v })}
              />
              <NumberField
                label="Price points"
                value={input.exponentialSegments}
                min={2}
                max={16}
                disabled={disabled}
                onChange={(v) => update({ exponentialSegments: Math.round(v) })}
              />
            </>
          ) : null}
        </div>
      </Section>

      {/* ---------------------------- Fee schedule ----------------------------- */}
      <Section title="Fee schedule" subtitle={`Protocol floor is ${MIN_FEE_BPS} bps.`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Mode"
            value={input.feeSchedule}
            options={FEE_SCHEDULES.map((s) => ({ value: s, label: FEE_SCHEDULE_LABEL[s] }))}
            disabled={disabled}
            onChange={(v) => update({ feeSchedule: v })}
          />
          <SelectField
            label="Fee collected in"
            value={input.collectFeeMode}
            options={[
              { value: CollectFeeMode.QuoteToken, label: 'Quote token (SOL)' },
              { value: CollectFeeMode.OutputToken, label: 'Output token' },
            ]}
            disabled={disabled}
            onChange={(v) => update({ collectFeeMode: v })}
          />

          {isRateLimiter ? (
            <>
              <NumberField
                label="Base fee"
                suffix="bps"
                value={input.rateLimiterBaseFeeBps}
                min={MIN_FEE_BPS}
                max={9900}
                disabled={disabled}
                onChange={(v) => update({ rateLimiterBaseFeeBps: Math.round(v) })}
              />
              <NumberField
                label="Fee increment"
                suffix="bps"
                value={input.rateLimiterFeeIncrementBps}
                min={0}
                max={9900}
                disabled={disabled}
                onChange={(v) => update({ rateLimiterFeeIncrementBps: Math.round(v) })}
              />
              <NumberField
                label="Reference amount"
                suffix="SOL"
                value={input.rateLimiterReferenceAmount}
                min={0.0001}
                step={0.1}
                disabled={disabled}
                onChange={(v) => update({ rateLimiterReferenceAmount: v })}
              />
              <NumberField
                label="Max limiter duration"
                suffix="sec"
                value={input.rateLimiterMaxDuration}
                min={0}
                max={31_536_000}
                step={60}
                disabled={disabled}
                onChange={(v) => update({ rateLimiterMaxDuration: Math.round(v) })}
              />
            </>
          ) : (
            <>
              <NumberField
                label="Starting fee"
                suffix="bps"
                value={input.startingFeeBps}
                min={MIN_FEE_BPS}
                max={9900}
                disabled={disabled}
                onChange={(v) => update({ startingFeeBps: Math.round(v) })}
              />
              <NumberField
                label="Ending fee"
                suffix="bps"
                value={input.endingFeeBps}
                min={MIN_FEE_BPS}
                max={9900}
                disabled={disabled}
                onChange={(v) => update({ endingFeeBps: Math.round(v) })}
              />
              <NumberField
                label="Periods"
                value={input.numberOfPeriods}
                min={0}
                max={100}
                disabled={disabled}
                onChange={(v) => update({ numberOfPeriods: Math.round(v) })}
              />
              <NumberField
                label="Total duration"
                suffix="sec"
                value={input.totalDuration}
                min={0}
                max={31_536_000}
                step={SECONDS_PER_DAY}
                disabled={disabled}
                onChange={(v) => update({ totalDuration: Math.round(v) })}
              />
            </>
          )}

          <NumberField
            label="Creator trading fee"
            hint="bonding-curve phase only"
            suffix="%"
            value={input.creatorTradingFeePercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) => update({ creatorTradingFeePercentage: Math.round(v) })}
          />
          <NumberField
            label="Pool creation fee"
            hint="charged per launch"
            suffix="SOL"
            value={input.poolCreationFee}
            min={0}
            max={100}
            step={0.05}
            disabled={disabled}
            onChange={(v) => update({ poolCreationFee: v })}
          />
        </div>
      </Section>

      {/* ----------------------------- Graduation ------------------------------ */}
      <Section
        title="Graduation"
        subtitle="Where the pool goes once the curve completes, and the fee it pays."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label="Migration target"
            value={input.migrationOption}
            options={[
              { value: MigrationOption.MET_DAMM_V2, label: 'Meteora DAMM v2' },
              { value: MigrationOption.MET_DAMM, label: 'Meteora DAMM v1' },
            ]}
            disabled={disabled}
            onChange={(v) => update({ migrationOption: v })}
          />
          <SelectField
            label="Migration LP fee"
            value={input.migrationFeeOption}
            options={SELECTABLE_MIGRATION_FEE_OPTIONS.map((o) => ({
              value: o,
              label: MIGRATION_FEE_OPTION_LABEL[o],
            }))}
            disabled={disabled}
            onChange={(v) => update({ migrationFeeOption: v })}
          />
          <NumberField
            label="Migration fee"
            hint="of threshold, taken once"
            suffix="%"
            value={input.migrationFeePercentage}
            min={0}
            max={MAX_MIGRATION_FEE_PERCENTAGE}
            disabled={disabled}
            onChange={(v) => update({ migrationFeePercentage: v })}
          />
          <NumberField
            label="Creator's share of that fee"
            suffix="%"
            value={input.creatorMigrationFeePercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) => update({ creatorMigrationFeePercentage: Math.round(v) })}
          />
        </div>
      </Section>

      {/* -------------------------- LP distribution ---------------------------- */}
      <Section
        title="LP distribution"
        subtitle={`Must total 100%, with at least ${MIN_LOCKED_LIQUIDITY_PERCENTAGE}% permanently locked.`}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label="Partner (claimable)"
            suffix="%"
            value={input.partnerLiquidityPercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) => update({ partnerLiquidityPercentage: Math.round(v) })}
          />
          <NumberField
            label="Creator (claimable)"
            suffix="%"
            value={input.creatorLiquidityPercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) => update({ creatorLiquidityPercentage: Math.round(v) })}
          />
          <NumberField
            label="Partner (locked)"
            suffix="%"
            value={input.partnerPermanentLockedLiquidityPercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) => update({ partnerPermanentLockedLiquidityPercentage: Math.round(v) })}
          />
          <NumberField
            label="Creator (locked)"
            suffix="%"
            value={input.creatorPermanentLockedLiquidityPercentage}
            min={0}
            max={100}
            disabled={disabled}
            onChange={(v) =>
              update({ creatorPermanentLockedLiquidityPercentage: Math.round(v) })
            }
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-2xs">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              lpTotal === 100
                ? 'bg-emerald/15 text-emerald'
                : 'bg-rose/15 text-rose'
            )}
          >
            Total {lpTotal}%
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 font-medium',
              lockedTotal >= MIN_LOCKED_LIQUIDITY_PERCENTAGE
                ? 'bg-emerald/15 text-emerald'
                : 'bg-amber/15 text-amber'
            )}
          >
            Locked {lockedTotal}%
          </span>
          {lpTotal !== 100 || lockedTotal < MIN_LOCKED_LIQUIDITY_PERCENTAGE ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                toast.info('Adjust the LP splits so they total 100% with at least 10% locked.')
              }
              className="text-neutral-500 underline underline-offset-2 hover:text-neutral-400"
            >
              why this matters
            </button>
          ) : null}
        </div>
      </Section>

      {usesMarketCap ? null : (
        <p className="text-2xs leading-relaxed text-neutral-500">
          The flat profile prices graduation directly from the migration quote threshold, so the
          market-cap fields above are not used.
        </p>
      )}
    </div>
  );
}

export default BondingCurveConfigurator;
