import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';

import { getRpcUrl, resolveCluster, type Cluster } from '@/lib/meteora';

type WalletProviderProps = {
  children: ReactNode;
  /** Override the cluster; defaults to `NEXT_PUBLIC_SOLANA_CLUSTER` or devnet. */
  cluster?: Cluster;
  /** Reconnect to the last-used wallet on mount. */
  autoConnect?: boolean;
};

/**
 * Browser-side Solana wallet context, pinned to Devnet.
 *
 * Deliberately separate from the scaffold's existing `UnifiedWalletProvider`
 * (Jupiter): the two libraries keep independent React contexts, so nesting this
 * one only scopes `useWallet()` to the launchpad subtree and leaves the rest of
 * the app untouched.
 *
 * Generated config/mint keypairs are created in `prepareLaunchTransaction`,
 * sign via `partialSign`, and are never persisted or transmitted.
 */
export function DbcWalletProvider({
  children,
  cluster,
  autoConnect = true,
}: WalletProviderProps) {
  const activeCluster = cluster ?? resolveCluster();

  // `Connection` speaks HTTP JSON-RPC, so this must be an https:// endpoint.
  // Passing a wss:// URL here type-checks fine but breaks every read at runtime.
  // `WalletProvider` derives its own WebSocket endpoint from this, so no explicit
  // `cluster` prop is needed (and WalletProviderProps does not accept one).
  const endpoint = useMemo(() => getRpcUrl(activeCluster), [activeCluster]);

  // Solana logs a benign "Wallet Adapter extraneous prop" warning if adapters
  // are rebuilt on every render, so this list must be referentially stable.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  const onError = useMemo(
    () => (error: Error) => {
      // Wallet-adapter surfaces user rejections here; never crash the tree.
      // eslint-disable-next-line no-console
      console.error('[wallet]', error.message);
    },
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider
        wallets={wallets}
        autoConnect={autoConnect}
        onError={onError}
        localStorageKey={`dbc-launchpad:${activeCluster}`}
      >
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default DbcWalletProvider;
