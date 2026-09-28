import { useCallback, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { toast } from 'sonner';

import { cn, shortenAddress } from '@/lib/utils';
import {
  DEVNET_FAUCET_URL,
  explorerAccountUrl,
  explorerTxUrl,
  extractErrorMessage,
  launchTokenSchema,
  prepareLaunchTransaction,
  resolveCluster,
  type CurvePreview,
  type CurvePresetId,
  type LaunchTokenInput,
  type PresetInput,
} from '@/lib/meteora';

export type LaunchStage =
  | 'idle'
  | 'building'
  | 'awaiting-signature'
  | 'submitted'
  | 'confirmed'
  | 'failed';

const STAGE_COPY: Record<LaunchStage, string> = {
  idle: 'Ready',
  building: 'Building transaction',
  'awaiting-signature': 'Confirm in wallet',
  submitted: 'Submitted to Devnet',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

export interface LaunchResult {
  signature: string;
  configAddress: string;
  baseMint: string;
  cluster: string;
}

type LaunchpadFormProps = {
  presetId: CurvePresetId;
  input: PresetInput;
  preview: CurvePreview | null;
  /** Why the curve is unusable, when it is. Shown instead of the launch button. */
  previewError?: string | null;
  /** Called with the launched addresses so the page can start polling progress. */
  onLaunched?: (result: LaunchResult) => void;
};

const inputClassName =
  'w-full rounded-lg border border-neutral-750 bg-background px-3 py-2 text-sm text-foreground placeholder:text-neutral-500 transition-colors focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50';

/**
 * Collects token identity and submits the DBC launch.
 *
 * The wallet signs; this component never holds a private key. Mint and config
 * keypairs are generated inside the SDK helper, co-sign with `partialSign`, and
 * are discarded once the transaction is confirmed.
 */
export function LaunchpadForm({
  presetId,
  input,
  preview,
  previewError,
  onLaunched,
}: LaunchpadFormProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [tokenName, setTokenName] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [metadataUri, setMetadataUri] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof LaunchTokenInput, string>>>(
    {}
  );
  const [stage, setStage] = useState<LaunchStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  const cluster = resolveCluster();
  const busy = stage === 'building' || stage === 'awaiting-signature' || stage === 'submitted';

  const reset = useCallback(() => {
    setStage('idle');
    setError(null);
    setResult(null);
  }, []);

  const validate = useCallback((): LaunchTokenInput | null => {
    const parsed = launchTokenSchema.safeParse({ tokenName, tokenSymbol, metadataUri });
    if (!parsed.success) {
      const next: Partial<Record<keyof LaunchTokenInput, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof LaunchTokenInput;
        if (field && !next[field]) next[field] = issue.message;
      }
      setFieldErrors(next);
      return null;
    }
    setFieldErrors({});
    return parsed.data;
  }, [metadataUri, tokenName, tokenSymbol]);

  const handleSubmit = useCallback(async () => {
    const values = validate();
    if (!values) {
      toast.error('Fix the highlighted fields before launching.');
      return;
    }
    if (!publicKey) {
      toast.error('Connect a wallet first.');
      return;
    }
    if (!preview) {
      toast.error('The current curve configuration is not valid. Adjust it in the configurator.');
      return;
    }

    setError(null);
    setResult(null);

    try {
      setStage('building');
      toast.loading('Building the launch transaction…');

      const prepared = await prepareLaunchTransaction(connection, {
        presetId,
        preview,
        input,
        tokenName: values.tokenName,
        tokenSymbol: values.tokenSymbol,
        metadataUri: values.metadataUri,
        creator: publicKey,
      });

      // Belt and braces: refuse to sign if the fee payer is not the connected
      // wallet or the DBC program is absent from the instruction set.
      if (!prepared.transaction.feePayer?.equals(publicKey)) {
        throw new Error('Refusing to sign: transaction fee payer is not the connected wallet.');
      }

      setStage('awaiting-signature');
      toast.message('Confirm the transaction in your wallet.');

      // The expiry window was captured alongside the blockhash that is baked into
      // the transaction's signatures. Re-fetching here would pair a fresh height
      // with an older blockhash, so use the pair the preparation returned.
      const { blockhash, lastValidBlockHeight } = prepared;

      const signature = await sendTransaction(prepared.transaction, connection);

      setStage('submitted');
      toast.loading(`Submitted: ${shortenAddress(signature)}`);

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      setStage('confirmed');
      setResult({
        signature,
        configAddress: prepared.config.toBase58(),
        baseMint: prepared.baseMint.toBase58(),
        cluster: prepared.cluster,
      });

      onLaunched?.({
        signature,
        configAddress: prepared.config.toBase58(),
        baseMint: prepared.baseMint.toBase58(),
        cluster: prepared.cluster,
      });

      toast.success('Token launched and pool created.');
    } catch (caught) {
      const message = extractErrorMessage(caught);
      setStage('failed');
      setError(message);
      // 4001 = user rejected the wallet prompt.
      if (message.toLowerCase().includes('reject')) {
        toast.warning('Signature rejected in wallet.');
      } else {
        toast.error(message);
      }
    }
  }, [
    connection,
    input,
    onLaunched,
    preview,
    presetId,
    publicKey,
    sendTransaction,
    validate,
  ]);

  if (!connected) {
    return (
      <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <span className="iconify h-6 w-6 text-primary-200 ph--wallet-bold" />
        </div>
        <h3 className="text-base font-semibold text-foreground">Connect a wallet</h3>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-neutral-400">
          Launching creates a new SPL mint, a partner config account, and a virtual pool. The
          signing wallet pays rent and any pool creation fee.
        </p>
        <div className="mt-5 flex justify-center">
          <WalletMultiButton />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Launch token</h3>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-2xs font-medium',
            stage === 'confirmed' && 'bg-emerald/15 text-emerald',
            stage === 'failed' && 'bg-rose/15 text-rose',
            busy && 'bg-primary/10 text-primary-200',
            stage === 'idle' && 'bg-neutral-800 text-neutral-400'
          )}
        >
          {STAGE_COPY[stage]}
        </span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="launch-name"
            label="Token name"
            error={fieldErrors.tokenName}
            input={
              <input
                id="launch-name"
                className={inputClassName}
                value={tokenName}
                maxLength={32}
                placeholder="Virtual Curve"
                disabled={busy}
                onChange={(e) => setTokenName(e.target.value)}
              />
            }
          />
          <Field
            id="launch-symbol"
            label="Symbol"
            error={fieldErrors.tokenSymbol}
            input={
              <input
                id="launch-symbol"
                className={inputClassName}
                value={tokenSymbol}
                maxLength={10}
                placeholder="VRTL"
                disabled={busy}
                onChange={(e) => setTokenSymbol(e.target.value)}
              />
            }
          />
        </div>

        <Field
          id="launch-uri"
          label="Metadata URI"
          hint="Must be HTTPS. Off-chain JSON is read by wallets at trade time."
          error={fieldErrors.metadataUri}
          input={
            <input
              id="launch-uri"
              className={inputClassName}
              value={metadataUri}
              placeholder="https://gateway.irys.xyz/your-metadata-json"
              disabled={busy}
              onChange={(e) => setMetadataUri(e.target.value)}
            />
          }
        />

        <div className="rounded-lg border border-neutral-850 bg-background/60 p-3">
          <p className="text-2xs uppercase tracking-wide text-neutral-500">Transaction summary</p>
          <dl className="mt-2 space-y-1.5 text-xs">
            <Row label="Cluster" value={cluster} />
            <Row label="Fee payer" value={publicKey ? shortenAddress(publicKey.toBase58()) : '-'} />
            <Row label="Preset" value={CURVE_PRESET_LABEL[presetId]} />
            <Row
              label="Graduation"
              value={preview ? `${preview.migrationTarget} · ${preview.migrationFeeLabel}` : '—'}
            />
            <Row
              label="Migration threshold"
              value={preview ? `${preview.migrationQuoteThresholdSol.toFixed(2)} SOL` : '—'}
            />
            <Row label="Pool creation fee" value={`${input.poolCreationFee} SOL`} />
          </dl>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose/40 bg-rose/10 p-3">
            <span className="iconify mt-0.5 h-4 w-4 shrink-0 text-rose ph--warning-circle-bold" />
            <p className="break-words text-xs leading-relaxed text-rose">{error}</p>
          </div>
        ) : null}

        {previewError ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 p-3">
            <span className="iconify mt-0.5 h-4 w-4 shrink-0 text-amber ph--warning-bold" />
            <p className="break-words text-xs leading-relaxed text-amber">
              Launch is blocked until the curve is valid: {previewError}
            </p>
          </div>
        ) : null}

        {result ? (
          <div className="rounded-lg border border-emerald/40 bg-emerald/10 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-emerald">
              <span className="iconify h-4 w-4 ph--check-circle-bold" />
              Launched on {result.cluster}
            </p>
            <dl className="mt-2 space-y-1 text-2xs">
              <LinkRow
                label="Transaction"
                value={result.signature}
                href={explorerTxUrl(result.signature, cluster)}
              />
              <LinkRow
                label="Config"
                value={result.configAddress}
                href={explorerAccountUrl(result.configAddress, cluster)}
              />
              <LinkRow
                label="Base mint"
                value={result.baseMint}
                href={explorerAccountUrl(result.baseMint, cluster)}
              />
            </dl>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy || !preview}
            className={cn(
              'inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5',
              'text-sm font-semibold text-primary-950 transition-colors',
              'hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            <span
              className={cn(
                'iconify h-4 w-4',
                busy ? 'ph--spinner animate-spin' : 'ph--rocket-launch-bold'
              )}
            />
            {busy ? STAGE_COPY[stage] : 'Launch token'}
          </button>

          {stage !== 'idle' ? (
            <button
              type="button"
              onClick={reset}
              className="text-xs text-neutral-400 underline underline-offset-2 hover:text-neutral-300"
            >
              Reset
            </button>
          ) : null}

          {cluster === 'devnet' ? (
            <a
              href={DEVNET_FAUCET_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-400"
            >
              Need devnet SOL?
            </a>
          ) : null}
        </div>
      </form>
    </div>
  );
}

const CURVE_PRESET_LABEL: Record<CurvePresetId, string> = {
  flat: 'Flat',
  exponential: 'Exponential',
  custom: 'Custom',
};

function Field({
  id,
  label,
  hint,
  error,
  input,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  input: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-neutral-300">
        {label}
      </label>
      {input}
      {error ? (
        <p className="mt-1 text-2xs text-rose">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-2xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="truncate font-mono text-neutral-300">{value}</dd>
    </div>
  );
}

function LinkRow({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 truncate">
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono text-emerald underline underline-offset-2"
          title={value}
        >
          {shortenAddress(value)}
        </a>
      </dd>
    </div>
  );
}

export default LaunchpadForm;
