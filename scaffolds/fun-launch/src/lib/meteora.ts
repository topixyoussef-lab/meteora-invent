import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Commitment } from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  buildCurveWithCustomSqrtPrices,
  buildCurveWithMarketCap,
  createSqrtPrices,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { ConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk';
// The SDK's `ConfigParameters` types its numerics as anchor's `BN`, so reuse that
// rather than depending on `@types/bn.js` separately.
import type { BN } from '@coral-xyz/anchor';
import Decimal from 'decimal.js';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                              Network / cluster                              */
/* -------------------------------------------------------------------------- */

export const CLUSTERS = ['devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const DEFAULT_CLUSTER: Cluster = 'devnet';

const CLUSTER_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

const CLUSTER_WS: Record<Cluster, string> = {
  devnet: 'wss://api.devnet.solana.com',
  'mainnet-beta': 'wss://api.mainnet-beta.solana.com',
};

/**
 * Resolves the RPC endpoint for a cluster.
 *
 * `NEXT_PUBLIC_SOLANA_RPC_URL` is a browser-visible variable, so it is only
 * offered as an *override* and never as the source of a secret. The SDK itself
 * requires no API key.
 */
export function getRpcUrl(cluster: Cluster = resolveCluster()): string {
  const override = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  return override && override.length > 0 ? override : CLUSTER_RPC[cluster];
}

export function getWsUrl(cluster: Cluster = resolveCluster()): string {
  return CLUSTER_WS[cluster];
}

export function resolveCluster(): Cluster {
  const raw = process.env.NEXT_PUBLIC_SOLANA_CLUSTER?.trim();
  return (CLUSTERS as readonly string[]).includes(raw ?? '') ? (raw as Cluster) : DEFAULT_CLUSTER;
}

const COMMITMENT: Commitment = 'confirmed';

// Keyed by endpoint, not by a single slot: a single cached Connection would
// hand a Devnet client to a caller that asked for mainnet-beta.
const connectionCache = new Map<string, Connection>();

/** Lazily created, memoised read-only connection. */
export function getConnection(cluster: Cluster = resolveCluster()): Connection {
  const endpoint = getRpcUrl(cluster);
  const cached = connectionCache.get(endpoint);
  if (cached) return cached;
  const connection = new Connection(endpoint, COMMITMENT);
  connectionCache.set(endpoint, connection);
  return connection;
}

/* -------------------------------------------------------------------------- */
/*                                  Constants                                  */
/* -------------------------------------------------------------------------- */

/** Identical on mainnet-beta and devnet. */
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/** Native SOL wrapped mint — the default quote asset. */
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export const QUOTE_DECIMALS = TokenDecimal.NINE;

/** Protocol floor for the base trading fee (1.4.6+). */
export const MIN_FEE_BPS = 25;
export const MAX_FEE_BPS = 9900;
export const MAX_MIGRATION_FEE_PERCENTAGE = 50;
export const MAX_CREATOR_MIGRATION_FEE_PERCENTAGE = 100;
export const MIN_POOL_CREATION_FEE_SOL = 0.001;
export const MAX_POOL_CREATION_FEE_SOL = 100;

/** Number of price points in the explicit-ladder (exponential) curve. */
export const MAX_PRICE_LADDER_POINTS = 16;

/** Protocol rule: >= 10% of LP must stay locked or vest for >= 1 day. */
export const MIN_LOCKED_LIQUIDITY_PERCENTAGE = 10;
export const SECONDS_PER_DAY = 86_400;

export const DEVNET_FAUCET_URL = 'https://faucet.solana.com/';
export const SOLSCAN_BASE_URL = 'https://solscan.io';

export function explorerTxUrl(signature: string, cluster: Cluster = resolveCluster()): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `${SOLSCAN_BASE_URL}/tx/${signature}${suffix}`;
}

export function explorerAccountUrl(address: PublicKey | string, cluster: Cluster = resolveCluster()) {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `${SOLSCAN_BASE_URL}/account/${address.toString()}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Preset model                               */
/* -------------------------------------------------------------------------- */

export const CURVE_PRESET_IDS = ['flat', 'exponential', 'custom'] as const;
export type CurvePresetId = (typeof CURVE_PRESET_IDS)[number];

export const FEE_SCHEDULES = ['linear', 'exponential', 'rateLimiter'] as const;
export type FeeSchedule = (typeof FEE_SCHEDULES)[number];

export const FEE_SCHEDULE_LABEL: Record<FeeSchedule, string> = {
  linear: 'Linear decay',
  exponential: 'Exponential decay',
  rateLimiter: 'Rate limiter (anti-bot)',
};

export const MIGRATION_FEE_OPTION_LABEL: Record<MigrationFeeOption, string> = {
  [MigrationFeeOption.FixedBps25]: '0.25% LP fee',
  [MigrationFeeOption.FixedBps30]: '0.30% LP fee',
  [MigrationFeeOption.FixedBps100]: '1.00% LP fee',
  [MigrationFeeOption.FixedBps200]: '2.00% LP fee',
  [MigrationFeeOption.FixedBps400]: '4.00% LP fee',
  [MigrationFeeOption.FixedBps600]: '6.00% LP fee',
  [MigrationFeeOption.Customizable]: 'Customizable',
};

/** The migration fee options the protocol accepts (option 6 needs `migratedPoolFee`). */
export const SELECTABLE_MIGRATION_FEE_OPTIONS: MigrationFeeOption[] = [
  MigrationFeeOption.FixedBps25,
  MigrationFeeOption.FixedBps30,
  MigrationFeeOption.FixedBps100,
  MigrationFeeOption.FixedBps200,
  MigrationFeeOption.FixedBps400,
  MigrationFeeOption.FixedBps600,
];

export const TOKEN_DECIMAL_OPTIONS: TokenDecimal[] = [
  TokenDecimal.SIX,
  TokenDecimal.SEVEN,
  TokenDecimal.EIGHT,
  TokenDecimal.NINE,
];

/** User-editable shape of a preset. Everything is in human units, not base units. */
export const presetInputSchema = z
  .object({
    totalTokenSupply: z.number().int().positive().max(1e15),
    /**
     * Tokens that stay unsold on the curve and become claimable by the creator
     * after migration. The multi-segment builders (`buildCurveWithCustomSqrtPrices`)
     * in SDK 1.5.11 throw `leftOverDelta must be less than totalLeftover` unless
     * this is greater than zero, so the exponential preset must set it.
     */
    leftover: z.number().int().min(0).max(1e15),
    tokenBaseDecimal: z.nativeEnum(TokenDecimal),
    tokenType: z.nativeEnum(TokenType),
    tokenAuthorityOption: z.nativeEnum(TokenAuthorityOption),

    // --- graduation targets -------------------------------------------------
    /** Used by `custom` (market-cap mode). */
    initialMarketCap: z.number().positive().max(1e12),
    migrationMarketCap: z.number().positive().max(1e12),
    /** Used by `flat` (threshold mode). */
    percentageSupplyOnMigration: z.number().min(1).max(100),
    migrationQuoteThreshold: z.number().positive().max(1e9),
    /** Used by `exponential` (explicit price ladder). */
    exponentialRamp: z.number().min(1.1).max(4),
    exponentialSegments: z.number().int().min(2).max(MAX_PRICE_LADDER_POINTS),

    // --- fees ---------------------------------------------------------------
    startingFeeBps: z.number().int().min(MIN_FEE_BPS).max(MAX_FEE_BPS),
    endingFeeBps: z.number().int().min(MIN_FEE_BPS).max(MAX_FEE_BPS),
    numberOfPeriods: z.number().int().min(0).max(100),
    totalDuration: z.number().int().min(0).max(31_536_000),
    feeSchedule: z.enum(FEE_SCHEDULES),
    rateLimiterBaseFeeBps: z.number().int().min(MIN_FEE_BPS).max(MAX_FEE_BPS),
    rateLimiterFeeIncrementBps: z.number().int().min(0).max(MAX_FEE_BPS),
    rateLimiterReferenceAmount: z.number().positive().max(1e12),
    rateLimiterMaxDuration: z.number().int().min(0).max(31_536_000),
    dynamicFeeEnabled: z.boolean(),
    collectFeeMode: z.nativeEnum(CollectFeeMode),
    creatorTradingFeePercentage: z.number().int().min(0).max(100),
    poolCreationFee: z.number().min(0).max(MAX_POOL_CREATION_FEE_SOL),
    enableFirstSwapWithMinFee: z.boolean(),

    // --- graduation ---------------------------------------------------------
    migrationOption: z.nativeEnum(MigrationOption),
    migrationFeeOption: z.nativeEnum(MigrationFeeOption),
    migrationFeePercentage: z.number().min(0).max(MAX_MIGRATION_FEE_PERCENTAGE),
    creatorMigrationFeePercentage: z.number().min(0).max(MAX_CREATOR_MIGRATION_FEE_PERCENTAGE),

    // --- LP distribution ----------------------------------------------------
    partnerLiquidityPercentage: z.number().int().min(0).max(100),
    partnerPermanentLockedLiquidityPercentage: z.number().int().min(0).max(100),
    creatorLiquidityPercentage: z.number().int().min(0).max(100),
    creatorPermanentLockedLiquidityPercentage: z.number().int().min(0).max(100),
  })
  .refine((v) => v.migrationMarketCap > v.initialMarketCap, {
    message: 'Graduation market cap must be greater than the initial market cap',
    path: ['migrationMarketCap'],
  })
  .refine((v) => v.endingFeeBps <= v.startingFeeBps, {
    message: 'Ending fee must be less than or equal to the starting fee',
    path: ['endingFeeBps'],
  })
  .refine(
    (v) =>
      v.partnerLiquidityPercentage +
        v.partnerPermanentLockedLiquidityPercentage +
        v.creatorLiquidityPercentage +
        v.creatorPermanentLockedLiquidityPercentage ===
      100,
    {
      message: 'LP distribution must total exactly 100%',
      path: ['creatorPermanentLockedLiquidityPercentage'],
    }
  )
  .refine(
    (v) =>
      v.partnerPermanentLockedLiquidityPercentage + v.creatorPermanentLockedLiquidityPercentage >=
      MIN_LOCKED_LIQUIDITY_PERCENTAGE,
    {
      message: `At least ${MIN_LOCKED_LIQUIDITY_PERCENTAGE}% of LP must stay permanently locked`,
      path: ['creatorPermanentLockedLiquidityPercentage'],
    }
  )
  .refine(
    (v) =>
      v.feeSchedule !== 'rateLimiter' || v.rateLimiterFeeIncrementBps > 0 ||
      v.rateLimiterBaseFeeBps <= MAX_FEE_BPS,
    {
      message: 'Rate limiter increment must be within bounds',
      path: ['rateLimiterFeeIncrementBps'],
    }
  );

export type PresetInput = z.infer<typeof presetInputSchema>;

/** Flat: single-segment constant product, priced from a quote threshold. */
export const FLAT_PRESET: PresetInput = {
  totalTokenSupply: 1_000_000_000,
  leftover: 0,
  tokenBaseDecimal: TokenDecimal.SIX,
  tokenType: TokenType.SPLToken,
  tokenAuthorityOption: TokenAuthorityOption.Immutable,

  initialMarketCap: 20,
  migrationMarketCap: 600,
  percentageSupplyOnMigration: 20,
  migrationQuoteThreshold: 10,
  exponentialRamp: 1.5,
  exponentialSegments: 8,

  startingFeeBps: 100,
  endingFeeBps: 100,
  numberOfPeriods: 0,
  totalDuration: 0,
  feeSchedule: 'linear',
  rateLimiterBaseFeeBps: 100,
  rateLimiterFeeIncrementBps: 200,
  rateLimiterReferenceAmount: 1,
  rateLimiterMaxDuration: 3_600,
  dynamicFeeEnabled: true,
  collectFeeMode: CollectFeeMode.QuoteToken,
  creatorTradingFeePercentage: 50,
  poolCreationFee: 0,
  enableFirstSwapWithMinFee: false,

  migrationOption: MigrationOption.MET_DAMM_V2,
  migrationFeeOption: MigrationFeeOption.FixedBps200,
  migrationFeePercentage: 0,
  creatorMigrationFeePercentage: 0,

  partnerLiquidityPercentage: 50,
  partnerPermanentLockedLiquidityPercentage: 5,
  creatorLiquidityPercentage: 40,
  creatorPermanentLockedLiquidityPercentage: 5,
};

/**
 * Exponential: an explicit geometric price ladder, so the price accelerates
 * roughly geometrically from the first band to graduation.
 *
 * The ladder is 0.1% of supply in `leftover` because the multi-segment builder
 * rejects `leftover: 0` in SDK 1.5.11.
 */
export const EXPONENTIAL_PRESET: PresetInput = {
  ...FLAT_PRESET,
  leftover: 1_000_000,
  exponentialRamp: 1.9,
  exponentialSegments: 8,
  startingFeeBps: 250,
  endingFeeBps: 100,
  numberOfPeriods: 20,
  totalDuration: 7 * SECONDS_PER_DAY,
  // Thin liquidity early means graduation must cost more.
  migrationMarketCap: 900,
  migrationQuoteThreshold: 25,
  creatorPermanentLockedLiquidityPercentage: 10,
  partnerPermanentLockedLiquidityPercentage: 10,
  partnerLiquidityPercentage: 45,
  creatorLiquidityPercentage: 35,
};

/** Custom: market-cap anchored, aggressive anti-bot fee ladder, graduated LP fee. */
export const CUSTOM_PRESET: PresetInput = {
  ...FLAT_PRESET,
  startingFeeBps: 400,
  endingFeeBps: 30,
  numberOfPeriods: 100,
  totalDuration: 30 * SECONDS_PER_DAY,
  feeSchedule: 'rateLimiter',
  rateLimiterBaseFeeBps: 100,
  rateLimiterFeeIncrementBps: 500,
  rateLimiterReferenceAmount: 0.5,
  rateLimiterMaxDuration: 3_600,
  dynamicFeeEnabled: true,
  migrationFeePercentage: 5,
  creatorMigrationFeePercentage: 50,
  migrationFeeOption: MigrationFeeOption.Customizable,
  poolCreationFee: 0.1,
  partnerLiquidityPercentage: 60,
  partnerPermanentLockedLiquidityPercentage: 10,
  creatorLiquidityPercentage: 20,
  creatorPermanentLockedLiquidityPercentage: 10,
};

export const CURVE_PRESETS: Record<
  CurvePresetId,
  { id: CurvePresetId; label: string; tagline: string; defaults: PresetInput }
> = {
  flat: {
    id: 'flat',
    label: 'Flat',
    tagline: 'Single constant-product segment. Predictable price, fast graduation.',
    defaults: FLAT_PRESET,
  },
  exponential: {
    id: 'exponential',
    label: 'Exponential',
    tagline: '16 weighted segments. Price accelerates as the curve thins out.',
    defaults: EXPONENTIAL_PRESET,
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    tagline: 'Rate-limiter fees + a graduated DAMM v2 LP fee. Full control.',
    defaults: CUSTOM_PRESET,
  },
};

/* -------------------------------------------------------------------------- */
/*                             Parameter generation                            */
/* -------------------------------------------------------------------------- */

/** Geometric price ladder used by the exponential preset. Ascending by construction. */
export function buildExponentialPriceLadder(ramp: number, points: number): number[] {
  const safeRamp = Math.min(Math.max(ramp, 1.01), 4);
  const safePoints = Math.min(Math.max(Math.round(points), 2), MAX_PRICE_LADDER_POINTS);
  // Normalise so a 1B supply at 6 decimals always starts in the same ballpark,
  // then apply the ramp. The final point is the graduation price.
  return Array.from({ length: safePoints }, (_, i) => 1e-9 * safeRamp ** i);
}

function buildBaseFeeParams(input: PresetInput) {
  if (input.feeSchedule === 'rateLimiter') {
    return {
      baseFeeMode: BaseFeeMode.RateLimiter as const,
      rateLimiterParam: {
        baseFeeBps: input.rateLimiterBaseFeeBps,
        feeIncrementBps: input.rateLimiterFeeIncrementBps,
        referenceAmount: input.rateLimiterReferenceAmount,
        maxLimiterDuration: input.rateLimiterMaxDuration,
      },
    };
  }

  return {
    baseFeeMode:
      input.feeSchedule === 'exponential'
        ? (BaseFeeMode.FeeSchedulerExponential as const)
        : (BaseFeeMode.FeeSchedulerLinear as const),
    feeSchedulerParam: {
      startingFeeBps: input.startingFeeBps,
      endingFeeBps: input.endingFeeBps,
      numberOfPeriod: input.numberOfPeriods,
      totalDuration: input.totalDuration,
    },
  };
}

/** Only meaningful for DAMM v2 graduates; option 6 additionally requires `migratedPoolFee`. */
function buildMigratedPoolFee(input: PresetInput) {
  if (input.migrationOption !== MigrationOption.MET_DAMM_V2) return undefined;
  if (input.migrationFeeOption !== MigrationFeeOption.Customizable) return undefined;

  return {
    collectFeeMode: MigratedCollectFeeMode.QuoteToken,
    dynamicFee: DammV2DynamicFeeMode.Enabled,
    poolFeeBps: input.startingFeeBps,
    baseFeeMode: DammV2BaseFeeMode.FeeMarketCapSchedulerExponential,
    marketCapFeeSchedulerParams: {
      endingBaseFeeBps: Math.max(MIN_FEE_BPS, input.endingFeeBps),
      numberOfPeriod: Math.max(1, input.numberOfPeriods),
      priceMultiple: Math.max(2, Math.round(input.migrationMarketCap / input.initialMarketCap)),
      schedulerExpirationDuration: Math.max(SECONDS_PER_DAY, input.totalDuration),
    },
  };
}

/** Shared fee / migration / LP / vesting block for every preset. */
function buildCommonParams(input: PresetInput) {
  return {
    token: {
      tokenType: input.tokenType,
      tokenBaseDecimal: input.tokenBaseDecimal,
      tokenQuoteDecimal: QUOTE_DECIMALS,
      tokenAuthorityOption: input.tokenAuthorityOption,
      totalTokenSupply: input.totalTokenSupply,
      leftover: input.leftover,
    },
    fee: {
      baseFeeParams: buildBaseFeeParams(input),
      dynamicFeeEnabled: input.dynamicFeeEnabled,
      collectFeeMode: input.collectFeeMode,
      creatorTradingFeePercentage: input.creatorTradingFeePercentage,
      poolCreationFee: input.poolCreationFee,
      enableFirstSwapWithMinFee: input.enableFirstSwapWithMinFee,
    },
    migration: {
      migrationOption: input.migrationOption,
      migrationFeeOption: input.migrationFeeOption,
      migrationFee: {
        feePercentage: input.migrationFeePercentage,
        creatorFeePercentage: input.creatorMigrationFeePercentage,
      },
      migratedPoolFee: buildMigratedPoolFee(input),
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: input.partnerLiquidityPercentage,
      partnerPermanentLockedLiquidityPercentage: input.partnerPermanentLockedLiquidityPercentage,
      creatorLiquidityPercentage: input.creatorLiquidityPercentage,
      creatorPermanentLockedLiquidityPercentage: input.creatorPermanentLockedLiquidityPercentage,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
  } as const;
}

/**
 * Preset 1 — flat curve.
 *
 * `buildCurve` is the single-segment constant-product builder (buildCurveMode 0):
 * the only mode where `migrationQuoteThreshold` is set directly rather than
 * derived from a market cap.
 */
export function buildFlatBondingCurve(input: PresetInput): ConfigParameters {
  return buildCurve({
    ...buildCommonParams(input),
    percentageSupplyOnMigration: input.percentageSupplyOnMigration,
    migrationQuoteThreshold: input.migrationQuoteThreshold,
  });
}

/**
 * Preset 2 — exponential curve.
 *
 * An explicit ascending price ladder, which is the only way to get a genuinely
 * multi-segment curve out of SDK 1.5.11: `buildCurveWithLiquidityWeights` is a
 * copy-paste of `buildCurveWithTwoSegments` that silently ignores its weights.
 */
export function buildExponentialBondingCurve(input: PresetInput): ConfigParameters {
  const prices = buildExponentialPriceLadder(input.exponentialRamp, input.exponentialSegments);
  return buildCurveWithCustomSqrtPrices({
    ...buildCommonParams(input),
    sqrtPrices: createSqrtPrices(prices, input.tokenBaseDecimal, QUOTE_DECIMALS),
  });
}

/**
 * Preset 3 — fully custom graduation.
 *
 * Market-cap anchored curve with an arbitrary fee ladder (fee scheduler or rate
 * limiter) and an explicit DAMM v1/v2 graduation fee. When the migration fee
 * option is `Customizable`, a DAMM v2 market-cap fee scheduler is attached so
 * the graduated pool keeps decaying fees after graduation.
 */
export function buildCustomBondingCurve(input: PresetInput): ConfigParameters {
  return buildCurveWithMarketCap({
    ...buildCommonParams(input),
    initialMarketCap: input.initialMarketCap,
    migrationMarketCap: input.migrationMarketCap,
  });
}

/** Shape-ladder preset: explicit ascending price points. */
export function buildCustomSqrtPriceCurve(
  input: PresetInput,
  prices: number[]
): ConfigParameters {
  const sorted = [...prices].filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (sorted.length < 2) {
    throw new Error('An explicit price ladder needs at least 2 ascending price points');
  }
  return buildCurveWithCustomSqrtPrices({
    ...buildCommonParams(input),
    sqrtPrices: createSqrtPrices(sorted, input.tokenBaseDecimal, QUOTE_DECIMALS),
  });
}

export const CURVE_BUILDERS: Record<CurvePresetId, (input: PresetInput) => ConfigParameters> = {
  flat: buildFlatBondingCurve,
  exponential: buildExponentialBondingCurve,
  custom: buildCustomBondingCurve,
};

/** Result of a full preset evaluation: the on-chain params plus derived readouts. */
export interface CurvePreview {
  presetId: CurvePresetId;
  params: ConfigParameters;
  startingPrice: number;
  migrationPrice: number;
  priceLadder: number[];
  migrationQuoteThresholdSol: number;
  priceMultiple: number;
  segments: number;
  /** Human units, i.e. already divided by 10^tokenBaseDecimal. */
  preMigrationSupply: number;
  postMigrationSupply: number;
  permanentLockedPercentage: number;
  startingFeeBps: number;
  endingFeeBps: number;
  migrationTarget: 'DAMM v1' | 'DAMM v2';
  migrationFeeLabel: string;
  protocolLockedRuleSatisfied: boolean;
  leftover: number;
}

function sqrtPriceToPrice(sqrtPrice: ConfigParameters['sqrtStartPrice'], base: TokenDecimal): number {
  return getPriceFromSqrtPrice(sqrtPrice, base, QUOTE_DECIMALS).toNumber();
}

/**
 * Runs the selected preset and derives the numbers the configurator renders.
 *
 * Throws whatever the SDK builder throws, so an impossible curve surfaces as a
 * readable error instead of a transaction that reverts on-chain.
 */
export function generateCurveParams(
  presetId: CurvePresetId,
  input: PresetInput
): CurvePreview {
  const params = CURVE_BUILDERS[presetId](input);

  const startingPrice = sqrtPriceToPrice(params.sqrtStartPrice, input.tokenBaseDecimal);

  // The last entry of `curve` is a sentinel, not a real price point. The SDK
  // exposes the real graduation price through this helper.
  const migrationPrice = sqrtPriceToPrice(
    getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve),
    input.tokenBaseDecimal
  );

  const scale = 10 ** input.tokenBaseDecimal;
  const preMigrationSupply = params.tokenSupply.preMigrationTokenSupply.toNumber() / scale;
  const postMigrationSupply = params.tokenSupply.postMigrationTokenSupply.toNumber() / scale;

  const permanentLockedPercentage =
    params.partnerPermanentLockedLiquidityPercentage + params.creatorPermanentLockedLiquidityPercentage;

  // `IdlTypes<...>['configParameters']` degrades to `any` for the `defined` IDL
  // structs, so narrow the two fields we read back rather than trusting the type.
  const curve = params.curve as Array<{ sqrtPrice: BN }>;
  const migrationFeeOption = params.migrationFeeOption as MigrationFeeOption;

  return {
    presetId,
    params,
    startingPrice,
    migrationPrice,
    priceLadder: curve.map((point) => sqrtPriceToPrice(point.sqrtPrice, input.tokenBaseDecimal)),
    migrationQuoteThresholdSol: new Decimal(params.migrationQuoteThreshold.toString())
      .div(10 ** QUOTE_DECIMALS)
      .toNumber(),
    priceMultiple: startingPrice > 0 ? migrationPrice / startingPrice : 0,
    segments: params.curve.length,
    preMigrationSupply,
    postMigrationSupply,
    permanentLockedPercentage,
    // `params.poolFees.baseFee` is the *computed* fee state (cliffFeeNumerator,
    // firstFactor, ...), so the requested bps have to come back off the input.
    startingFeeBps: input.startingFeeBps,
    endingFeeBps: input.endingFeeBps,
    migrationTarget:
      (params.migrationOption as MigrationOption) === MigrationOption.MET_DAMM_V2
        ? 'DAMM v2'
        : 'DAMM v1',
    migrationFeeLabel: MIGRATION_FEE_OPTION_LABEL[migrationFeeOption],
    protocolLockedRuleSatisfied: permanentLockedPercentage >= MIN_LOCKED_LIQUIDITY_PERCENTAGE,
    leftover: input.leftover,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Transaction construction                           */
/* -------------------------------------------------------------------------- */

export interface DbcClientConfig {
  feeClaimer?: PublicKey | null;
  leftoverReceiver?: PublicKey | null;
  baseMint?: PublicKey | null;
}

/** Singleton service client. Namespaces: partner / creator / pool / migration / state. */
export function getDbcClient(connection: Connection): DynamicBondingCurveClient {
  return new DynamicBondingCurveClient(connection, COMMITMENT);
}

/**
 * Minimal, non-throwing validity probe used to gate the Launch button.
 *
 * Deliberately does *not* call the SDK's `validateConfigParameters`: in 1.5.11
 * that helper is typed for `ConfigParameters` but throws
 * `Cannot read properties of undefined (reading '_bn')` on any input produced by
 * the `buildCurve*` builders. The builders themselves already raise on
 * impossible curves, and `presetInputSchema` covers the domain rules, so
 * re-running `generateCurveParams` is the meaningful check.
 */
export function isConfigParamsValid(
  presetId: CurvePresetId,
  input: PresetInput
): { valid: boolean; error?: string } {
  const parsed = presetInputSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, error: parsed.error.issues[0]?.message ?? 'Invalid curve parameters' };
  }
  try {
    generateCurveParams(presetId, parsed.data);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface LaunchLaunchpadParams {
  presetId: CurvePresetId;
  preview: CurvePreview;
  input: PresetInput;
  tokenName: string;
  tokenSymbol: string;
  metadataUri: string;
  creator: PublicKey;
  config?: PublicKey | null;
  baseMint?: PublicKey | null;
  feeClaimer?: PublicKey | null;
  leftoverReceiver?: PublicKey | null;
  computeUnitPriceMicroLamports?: number;
}

export interface PreparedLaunch {
  transaction: import('@solana/web3.js').Transaction;
  config: PublicKey;
  baseMint: PublicKey;
  /** Generated locally and discarded after signing — never persisted. */
  configKeypair: Keypair;
  baseMintKeypair: Keypair;
  cluster: Cluster;
  /**
   * The expiry window paired with `transaction.recentBlockhash`. Both come from
   * the same `getLatestBlockhash` call so confirmation uses a matching pair.
   *
   * Callers must confirm with this exact pair. Re-fetching the height and mixing
   * it with the transaction's blockhash can produce a window that no longer
   * covers the block the transaction landed in. The blockhash is set *before*
   * `partialSign`, so it cannot be swapped afterwards without re-signing.
   */
  blockhash: string;
  lastValidBlockHeight: number;
}

export const launchTokenSchema = z.object({
  tokenName: z
    .string()
    .trim()
    .min(2, 'Token name must be at least 2 characters')
    .max(32, 'Token name must be at most 32 characters'),
  tokenSymbol: z
    .string()
    .trim()
    .min(1, 'Token symbol is required')
    .max(10, 'Token symbol must be at most 10 characters')
    .regex(/^[A-Za-z0-9._\-\s]+$/, 'Symbol may only contain letters, numbers, . _ - and spaces'),
  metadataUri: z
    .string()
    .trim()
    .url('Metadata URI must be a valid absolute URL')
    .refine(
      (v) => /^https:\/\//i.test(v),
      'Metadata URI must use HTTPS (never fetch or trust plain HTTP metadata)'
    ),
});

export type LaunchTokenInput = z.infer<typeof launchTokenSchema>;

/**
 * Builds the on-chain launch.
 *
 * Two shapes:
 *  - no `config`: one transaction that creates the partner config *and* the
 *    virtual pool (the real equivalent of "create a token on a dynamic curve").
 *  - with `config`: a creator-side `createPool` against an existing preset.
 *
 * `payer` is always the connected wallet. Mint/config keypairs are generated in
 * memory, sign the transaction via `partialSign`, and are never written to disk
 * or sent anywhere.
 */
export async function prepareLaunchTransaction(
  connection: Connection,
  params: LaunchLaunchpadParams
): Promise<PreparedLaunch> {
  const {
    presetId,
    preview,
    input,
    tokenName,
    tokenSymbol,
    metadataUri,
    creator,
    config,
    baseMint,
    feeClaimer,
    leftoverReceiver,
    computeUnitPriceMicroLamports = 100_000,
  } = params;

  const client = getDbcClient(connection);
  const configKeypair = Keypair.generate();
  const configPubkey = config ?? configKeypair.publicKey;
  const baseMintKeypair = Keypair.generate();
  const baseMintPubkey = baseMint ?? baseMintKeypair.publicKey;

  // The partner earns the pre-graduation trading-fee share; the creator earns the
  // post-graduation LP share. Self-launches collapse to a single address.
  const feeClaimerPubkey = feeClaimer ?? creator;
  const leftoverReceiverPubkey = leftoverReceiver ?? creator;

  // Re-derive the curve from the submitted input *before* touching the SDK, so an
  // impossible configuration fails instantly and cheaply — long before the wallet
  // is asked to sign, and without building a transaction we would throw away.
  if (!config) {
    const recheck = isConfigParamsValid(presetId, input);
    if (!recheck.valid) {
      throw new Error(`Curve parameters rejected: ${recheck.error}`);
    }
  }

  const transaction = config
    ? await client.creator.createPool({
        name: tokenName,
        symbol: tokenSymbol,
        uri: metadataUri,
        payer: creator,
        poolCreator: creator,
        config: configPubkey,
        baseMint: baseMintPubkey,
      })
    : await client.partner.createConfigAndPool({
        config: configPubkey,
        feeClaimer: feeClaimerPubkey,
        leftoverReceiver: leftoverReceiverPubkey,
        payer: creator,
        quoteMint: WSOL_MINT,
        preCreatePoolParam: {
          name: tokenName,
          symbol: tokenSymbol,
          uri: metadataUri,
          poolCreator: creator,
          baseMint: baseMintPubkey,
        },
        ...preview.params,
      });

  // A config account is large; raise the compute price so it lands reliably.
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports })
  );

  transaction.feePayer = creator;

  // One call, one window. The blockhash is baked into the signatures below, and
  // the height must describe that same blockhash or the confirmation window is
  // meaningless.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;

  // Generated accounts must co-sign. Done before the wallet is asked to sign.
  if (!config) transaction.partialSign(configKeypair);
  if (!baseMint) transaction.partialSign(baseMintKeypair);

  return {
    transaction,
    config: configPubkey,
    baseMint: baseMintPubkey,
    configKeypair,
    baseMintKeypair,
    cluster: resolveCluster(),
    blockhash,
    lastValidBlockHeight,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Read helpers                                */
/* -------------------------------------------------------------------------- */

export interface PoolProgress {
  baseMint: PublicKey;
  poolAddress: PublicKey | null;
  quoteReserveSol: number;
  migrationQuoteThresholdSol: number;
  progress: number;
  isMigrated: boolean;
}

/** Reads live curve progress for a launched token. Safe to call repeatedly. */
export async function fetchPoolProgress(
  connection: Connection,
  baseMint: PublicKey
): Promise<PoolProgress> {
  const client = getDbcClient(connection);
  const pool = await client.state.getPoolByBaseMint(baseMint);
  if (!pool) {
    return {
      baseMint,
      poolAddress: null,
      quoteReserveSol: 0,
      migrationQuoteThresholdSol: 0,
      progress: 0,
      isMigrated: false,
    };
  }

  const state = await client.state.getPool(pool.publicKey);
  if (!state) {
    return {
      baseMint,
      poolAddress: pool.publicKey,
      quoteReserveSol: 0,
      migrationQuoteThresholdSol: 0,
      progress: 0,
      isMigrated: false,
    };
  }

  const poolState = state.poolState;
  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool.publicKey);

  return {
    baseMint,
    poolAddress: pool.publicKey,
    quoteReserveSol: new Decimal(poolState.quoteReserve.toString()).div(10 ** QUOTE_DECIMALS).toNumber(),
    migrationQuoteThresholdSol: new Decimal(
      poolState.migrationQuoteThreshold.toString()
    ).div(10 ** QUOTE_DECIMALS).toNumber(),
    progress: Number(progress),
    isMigrated: Boolean(poolState.isMigrated),
  };
}

/** Best-effort program-log extraction for a failed transaction. */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const logs = (error as { logs?: string[] }).logs;
    if (Array.isArray(logs) && logs.length > 0) {
      const failure = [...logs].reverse().find((l) => l.includes('Error:') || l.includes('failed'));
      if (failure) return failure.trim();
    }
    return error.message;
  }
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
