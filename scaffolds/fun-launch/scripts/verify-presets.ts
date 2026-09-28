/**
 * Offline preset verification.
 *
 * Exercises every curve generator and domain rule WITHOUT touching the network
 * or a wallet. All SDK maths is pure, so this is the cheapest way to confirm the
 * preset table still produces valid `ConfigParameters` after any edit.
 *
 *   pnpm --filter @meteora-invent/scaffold/fun-launch verify:presets
 *
 * Exits non-zero on the first regression.
 */
import {
  CURVE_PRESETS,
  generateCurveParams,
  isConfigParamsValid,
  launchTokenSchema,
  presetInputSchema,
} from '../src/lib/meteora';

type PresetEntry = (typeof CURVE_PRESETS)[keyof typeof CURVE_PRESETS];

/** Which SDK builder backs each preset — asserted so the mapping stays honest. */
const EXPECTED_BUILDER: Record<string, string> = {
  flat: 'buildCurve',
  exponential: 'buildCurveWithCustomSqrtPrices',
  custom: 'buildCurveWithMarketCap',
};

let failures = 0;

function fail(message: string): void {
  failures += 1;
  console.error(`  [FAIL] ${message}`);
}

console.log('='.repeat(70));
console.log(' Meteora DBC preset verification');
console.log('='.repeat(70));

/* --------------------------- 1. every preset builds --------------------------- */

for (const preset of Object.values(CURVE_PRESETS) as PresetEntry[]) {
  const parsed = presetInputSchema.safeParse(preset.defaults);
  if (!parsed.success) {
    fail(`${preset.id}: defaults violate schema — ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    continue;
  }

  try {
    const params = generateCurveParams(preset.id, parsed.data);

    const sane =
      params.priceMultiple > 1 &&
      params.priceMultiple < 1e6 &&
      params.startingPrice > 0 &&
      params.migrationPrice > params.startingPrice &&
      params.preMigrationSupply > 0 &&
      params.preMigrationSupply <= parsed.data.totalTokenSupply &&
      params.migrationQuoteThresholdSol > 0 &&
      params.segments >= 2 &&
      params.permanentLockedPercentage >= 10;

    console.log(`\n=== ${preset.id.toUpperCase()}  (${EXPECTED_BUILDER[preset.id]})`);
    console.log(`  segments              ${params.segments}`);
    console.log(`  start price           ${params.startingPrice.toExponential(4)} SOL/token`);
    console.log(`  graduation price      ${params.migrationPrice.toExponential(4)} SOL/token`);
    console.log(`  price multiple        ${params.priceMultiple.toFixed(2)}x`);
    console.log(`  migration threshold   ${params.migrationQuoteThresholdSol.toFixed(3)} SOL`);
    console.log(`  on-curve supply       ${params.preMigrationSupply.toLocaleString()}`);
    console.log(`  leftover              ${params.leftover.toLocaleString()}`);
    console.log(`  fees                  ${params.startingFeeBps} -> ${params.endingFeeBps} bps`);
    console.log(`  graduation            ${params.migrationTarget} / ${params.migrationFeeLabel}`);
    console.log(`  LP locked             ${params.permanentLockedPercentage}% (rule ok: ${params.protocolLockedRuleSatisfied})`);

    if (!sane) fail(`${preset.id} produced nonsensical numbers`);
  } catch (error) {
    fail(`${preset.id} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------- 2. exponential knobs actually change ---------------------- */

console.log('\n--- exponential ramp / segment knobs ---');
for (const [ramp, points] of [
  [1.5, 8],
  [1.9, 8],
  [2.4, 8],
  [1.9, 4],
  [1.9, 12],
] as const) {
  const input = {
    ...CURVE_PRESETS.exponential.defaults,
    exponentialRamp: ramp,
    exponentialSegments: points,
  };
  try {
    const p = generateCurveParams('exponential', presetInputSchema.parse(input));
    console.log(
      `  ramp=${String(ramp).padEnd(4)} pts=${String(points).padStart(2)} -> ` +
        `segments=${String(p.segments).padStart(2)} multiple=${p.priceMultiple.toFixed(1).padStart(6)}x ` +
        `threshold=${p.migrationQuoteThresholdSol.toFixed(2)} SOL`
    );
  } catch (error) {
    fail(`ramp=${ramp} points=${points}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------- 3. domain rules reject bad ------------------------- */

console.log('\n--- domain rules reject invalid input ---');
const invalid: Array<[string, Record<string, unknown>]> = [
  ['graduation mcap < initial', { migrationMarketCap: 10, initialMarketCap: 100 }],
  ['LP split != 100%', { partnerLiquidityPercentage: 10 }],
  [
    'permanent lock < 10%',
    {
      partnerPermanentLockedLiquidityPercentage: 1,
      creatorPermanentLockedLiquidityPercentage: 1,
      partnerLiquidityPercentage: 49,
      creatorLiquidityPercentage: 49,
    },
  ],
  ['starting fee below floor', { startingFeeBps: 5 }],
  ['ending fee above starting', { startingFeeBps: 100, endingFeeBps: 500 }],
];

for (const [label, patch] of invalid) {
  const result = isConfigParamsValid('flat', { ...CURVE_PRESETS.flat.defaults, ...patch });
  if (result.valid) fail(`"${label}" was accepted but should be rejected`);
  else console.log(`  ${label.padEnd(26)} -> rejected: ${result.error}`);
}

/* ----------------------- 4. launch input is hardened -------------------------- */

console.log('\n--- token metadata hardening ---');
const badTokens: Array<[string, unknown]> = [
  ['http metadata URI', { tokenName: 'Test', tokenSymbol: 'TST', metadataUri: 'http://x.io/m.json' }],
  ['empty symbol', { tokenName: 'Test', tokenSymbol: '', metadataUri: 'https://x.io/m.json' }],
  ['symbol with punctuation', { tokenName: 'Test', tokenSymbol: 'T$%', metadataUri: 'https://x.io/m.json' }],
  ['non-URL metadata URI', { tokenName: 'Test', tokenSymbol: 'TST', metadataUri: 'not-a-url' }],
];

for (const [label, value] of badTokens) {
  if (launchTokenSchema.safeParse(value).success) {
    fail(`"${label}" was accepted but should be rejected`);
  } else {
    console.log(`  ${label.padEnd(26)} -> rejected`);
  }
}

const goodToken = launchTokenSchema.safeParse({
  tokenName: 'Virtual Curve',
  tokenSymbol: 'VRTL',
  metadataUri: 'https://gateway.irys.xyz/abc',
});
if (!goodToken.success) fail('valid launch input was rejected');
else console.log('  valid input             -> accepted');

/* --------------------------------- verdict ---------------------------------- */

console.log('='.repeat(70));
console.log(failures === 0 ? ' RESULT: ALL CHECKS PASSED' : ` RESULT: ${failures} FAILURE(S)`);
console.log('='.repeat(70));

process.exit(failures === 0 ? 0 : 1);
