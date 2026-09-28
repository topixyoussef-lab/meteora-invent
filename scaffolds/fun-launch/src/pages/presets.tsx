import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

import BondingCurveConfigurator from '@/components/BondingCurveConfigurator';
import LaunchpadForm, { type LaunchResult } from '@/components/LaunchpadForm';
import DbcWalletProvider from '@/components/WalletProvider';
import { cn, shortenAddress } from '@/lib/utils';
import {
  CURVE_PRESETS,
  DBC_PROGRAM_ID,
  explorerAccountUrl,
  fetchPoolProgress,
  generateCurveParams,
  presetInputSchema,
  resolveCluster,
  type CurvePreview,
  type CurvePresetId,
  type PoolProgress,
  type PresetInput,
} from '@/lib/meteora';

type LogEntry = {
  id: number;
  at: string;
  level: 'info' | 'success' | 'error';
  message: string;
};

let logId = 0;

function LaunchpadConsole() {
  const { connection } = useConnection();

  const [presetId, setPresetId] = useState<CurvePresetId>('flat');
  const [input, setInput] = useState<PresetInput>({ ...CURVE_PRESETS.flat.defaults });
  const [progress, setProgress] = useState<PoolProgress | null>(null);
  /** Base mint currently being polled; set on a successful launch. */
  const [polledMint, setPolledMint] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const cluster = resolveCluster();

  // Same computation the configurator renders, so the Launch button reflects the
  // exact params that will be submitted.
  const { preview, previewError } = useMemo<{
    preview: CurvePreview | null;
    previewError: string | null;
  }>(() => {
    const parsed = presetInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        preview: null,
        previewError: parsed.error.issues[0]?.message ?? 'Invalid curve parameters',
      };
    }
    try {
      return { preview: generateCurveParams(presetId, parsed.data), previewError: null };
    } catch (error) {
      return {
        preview: null,
        previewError: error instanceof Error ? error.message : String(error),
      };
    }
  }, [input, presetId]);

  const appendLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) =>
      [
        {
          id: (logId += 1),
          at: new Date().toLocaleTimeString('en-GB', { hour12: false }),
          level,
          message,
        },
        ...prev,
      ].slice(0, 40)
    );
  }, []);

  const handleCurveChange = useCallback((nextPreset: CurvePresetId, nextInput: PresetInput) => {
    setPresetId(nextPreset);
    setInput(nextInput);
  }, []);

  const handleLaunched = useCallback(
    (result: LaunchResult) => {
      appendLog('success', `Config ${shortenAddress(result.configAddress)}`);
      appendLog('success', `Base mint ${shortenAddress(result.baseMint)}`);
      appendLog('success', `Tx ${shortenAddress(result.signature)}`);
      // Kick off live polling for the pool this launch just created.
      setPolledMint(result.baseMint);
    },
    [appendLog]
  );

  // Poll the freshly created pool so the readout reflects real chain state.
  // Keyed on `polledMint` rather than `progress` so that updating the readout does
  // not re-trigger the effect and spin a request loop.
  useEffect(() => {
    // Nothing to poll until a launch reports its base mint. Explicit `undefined`
    // keeps the effect's return type uniform for `noImplicitReturns`.
    if (!polledMint) return undefined;
    let cancelled = false;
    let lastPool: string | null = null;

    const poll = async () => {
      try {
        const next = await fetchPoolProgress(connection, new PublicKey(polledMint));
        if (cancelled) return;
        setProgress(next);
        // Announce the pool once it appears, not on every tick.
        if (next.poolAddress && next.poolAddress.toBase58() !== lastPool) {
          lastPool = next.poolAddress.toBase58();
          appendLog('info', `Pool ${shortenAddress(lastPool)} live on ${cluster}`);
        }
      } catch (error) {
        if (!cancelled) {
          appendLog(
            'error',
            error instanceof Error ? error.message : 'Failed to read pool state'
          );
        }
      }
    };

    void poll();
    const timer = setInterval(poll, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polledMint, connection, cluster, appendLog]);

  const clusterPill = useMemo(
    () => (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-background/60 px-2.5 py-1 text-2xs font-medium text-neutral-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald" />
        {cluster}
      </span>
    ),
    [cluster]
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Head>
        <title>DBC Config Preset Marketplace — Meteora</title>
        <meta
          name="description"
          content="Configure, preview and launch a Meteora Dynamic Bonding Curve with graduation to DAMM v2."
        />
      </Head>

      {/* ------------------------------- Header ------------------------------- */}
      <header className="sticky top-0 z-20 border-b border-neutral-850 bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15">
              <span className="iconify h-4 w-4 text-primary-200 ph--graph-bold" />
            </span>
            <div>
              <h1 className="text-sm font-semibold leading-tight">DBC Preset Marketplace</h1>
              <p className="text-2xs text-neutral-500">Meteora Dynamic Bonding Curve → DAMM v2</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {clusterPill}
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8">
        {/* ------------------------------ Hero -------------------------------- */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
            Ship a bonding curve in minutes
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-neutral-400">
            Pick a curve profile, tune the economics, and launch. Every parameter is computed by
            the Meteora DBC SDK itself, so what you preview is exactly what lands on-chain — the
            pool graduates to {CURVE_PRESETS[presetId].label.toLowerCase()}-configured DAMM v2 when
            the quote reserve crosses the migration threshold.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* ------------------------- Configurator --------------------------- */}
          <BondingCurveConfigurator
            presetId={presetId}
            input={input}
            onChange={handleCurveChange}
          />

          {/* ------------------------ Side rail --------------------------- */}
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <LaunchpadForm
              presetId={presetId}
              input={input}
              preview={preview}
              previewError={previewError}
              onLaunched={handleLaunched}
            />

            {/* Live pool progress */}
            {progress ? (
              <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
                <h3 className="text-sm font-semibold text-foreground">Pool progress</h3>
                {progress.poolAddress ? (
                  <>
                    <div className="mt-3">
                      <div className="mb-1.5 flex items-baseline justify-between text-2xs">
                        <span className="text-neutral-500">Curve completion</span>
                        <span className="font-mono text-neutral-300">
                          {(progress.progress * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-850">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            progress.isMigrated ? 'bg-emerald' : 'bg-primary'
                          )}
                          style={{ width: `${Math.min(100, progress.progress * 100)}%` }}
                        />
                      </div>
                    </div>
                    <dl className="mt-3 space-y-1.5 text-2xs">
                      <ProgressRow
                        label="Quote reserve"
                        value={`${progress.quoteReserveSol.toFixed(3)} SOL`}
                      />
                      <ProgressRow
                        label="Threshold"
                        value={`${progress.migrationQuoteThresholdSol.toFixed(3)} SOL`}
                      />
                      <ProgressRow
                        label="State"
                        value={progress.isMigrated ? 'Graduated → DAMM v2' : 'On bonding curve'}
                        tone={progress.isMigrated ? 'good' : 'default'}
                      />
                    </dl>
                    <a
                      href={explorerAccountUrl(progress.poolAddress.toBase58(), cluster)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-3 inline-flex items-center gap-1 text-2xs text-emerald underline underline-offset-2"
                    >
                      View pool on Solscan
                      <span className="iconify h-3 w-3 ph--arrow-square-out-bold" />
                    </a>
                  </>
                ) : (
                  <p className="mt-2 text-2xs text-neutral-500">
                    Pool account not indexed yet. This is normal on the first few seconds of Devnet.
                  </p>
                )}
              </div>
            ) : null}

            {/* Transaction log */}
            <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Transaction log</h3>
                {logs.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setLogs([])}
                    className="text-2xs text-neutral-500 hover:text-neutral-400"
                  >
                    clear
                  </button>
                ) : null}
              </div>
              {logs.length === 0 ? (
                <p className="text-2xs text-neutral-500">
                  Live transaction status will appear here.
                </p>
              ) : (
                <ul className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-none">
                  {logs.map((entry) => (
                    <li key={entry.id} className="flex items-start gap-2 font-mono text-2xs">
                      <span className="shrink-0 text-neutral-600">{entry.at}</span>
                      <span
                        className={cn(
                          entry.level === 'success' && 'text-emerald',
                          entry.level === 'error' && 'text-rose',
                          entry.level === 'info' && 'text-neutral-400'
                        )}
                      >
                        {entry.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
              <h3 className="text-sm font-semibold text-foreground">Program</h3>
              <a
                href={explorerAccountUrl(DBC_PROGRAM_ID, cluster)}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 block break-all font-mono text-2xs text-emerald underline underline-offset-2"
              >
                {DBC_PROGRAM_ID.toBase58()}
              </a>
              <p className="mt-2 text-2xs leading-relaxed text-neutral-500">
                Same program ID on Devnet and mainnet-beta. Keep test launches on Devnet until the
                economics look right.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'good';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={cn('font-mono', tone === 'good' ? 'text-emerald' : 'text-neutral-300')}>
        {value}
      </dd>
    </div>
  );
}

export default function PresetMarketplace() {
  return (
    <DbcWalletProvider>
      <LaunchpadConsole />
    </DbcWalletProvider>
  );
}
